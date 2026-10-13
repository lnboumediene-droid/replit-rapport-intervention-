import { createContext, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { fetchGensparkUser, type GensparkUser } from './genspark-auth';
import {
  ArrowDownRight, ArrowLeft, ArrowRight, Building2, Camera, Check,
  ClipboardList, Eraser, FileUp, FilePlus2, FileText, Filter, Home, LoaderCircle, LogOut,
  MapPin, Plus, Search, Settings, ShieldCheck, Sparkles, UserRound, Users, Wrench, X,
} from 'lucide-react';
import {
  Route, Switch, Link, Redirect, Router as WouterRouter, useLocation, useParams, useSearch,
} from 'wouter';
import {
  useGetCurrentUser, getGetCurrentUserQueryKey, useGetDashboardSummary, getGetDashboardSummaryQueryKey,
  useListClients, getListClientsQueryKey, useCreateClient, useUpdateClient,
  useListSites, getListSitesQueryKey, useCreateSite, useUpdateSite,
  useListReports, getListReportsQueryKey, useCreateReport,
  useGetReport, getGetReportQueryKey, useUpdateReport, useCreateReportZone,
  useUpdateReportZone, useFormatReportZone, useApplyReportZoneFormat,
  useRequestReportPhotoUpload, useCreateReportPhoto, useUpdateReportPhoto,
  useTransitionReportStatus, useGenerateReportPdf,
  useListReportVersions, getListReportVersionsQueryKey,
} from '@workspace/api-client-react';
import { ImportPage, ImportReviewPage, ErasedNamesPage } from './ImportPages';
import { DeleteReportButton } from './DeleteReportButton';

export const queryClient = new QueryClient();
export const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// Identity now comes from Genspark ("Sign in with Genspark" access mode) instead
// of Clerk. The context mirrors the old Clerk `Show`/`useClerk` surface so the
// rest of the app is unchanged: `signedIn` drives Protected/HomeRedirect, and
// `signOut` hits the edge-provided logout endpoint.
type AuthState = { loaded: boolean; user: GensparkUser | null };
const GensparkAuthContext = createContext<AuthState>({ loaded: false, user: null });
function useGensparkAuth() { return useContext(GensparkAuthContext); }
function signOutGenspark() { window.location.href = '/__genspark_auth/logout'; }
const roles: Record<string, string> = {
  intervenant: 'Intervenant', responsable_terrain: 'Responsable terrain',
  administratif: 'Administration', direction: 'Direction',
};
const statusLabels: Record<string, string> = {
  brouillon: 'Brouillon', a_verifier: 'À vérifier', a_corriger: 'À corriger',
  valide: 'Validé', pret_a_envoyer: 'Prêt à envoyer', envoye: 'Envoyé',
};
export const roleCanManage = (role?: string) => role === 'responsable_terrain' || role === 'administratif' || role === 'direction';

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

function Brand({ inverse = false }: { inverse?: boolean }) {
  return <div className="brand" style={{ color: inverse ? '#fff' : '#1F1B4D', padding: 0 }}>
    <div className="brand-mark">MB</div><span>MSB-BAT <span style={{ fontWeight: 500, opacity: .72 }}>· Rapports</span></span>
  </div>;
}

function Landing() {
  return <>
    <div className="landing">
      <nav className="landing-nav"><Brand />
        <div style={{ display: 'flex', gap: 9 }}>
          <Link href="/sign-in" className="btn btn-plain">Se connecter</Link>
          <Link href="/sign-up" className="btn btn-primary">Accéder à l’espace <ArrowRight size={15} /></Link>
        </div>
      </nav>
      <main className="hero">
        <div>
          <div className="eyebrow">MSB-BAT · Interventions terrain</div>
          <h1>Le bon suivi,<br /><span>sur le terrain.</span></h1>
          <p className="hero-copy">Chaque intervention documentée avec précision. Des notes de chantier au rapport prêt à classer, tout reste clair et au même endroit.</p>
          <Link href="/sign-in" className="btn btn-primary">Ouvrir mon espace <ArrowRight size={16} /></Link>
          <p style={{ fontSize: 11, color: '#817b98', marginTop: 17 }}>Un espace de travail réservé aux équipes MSB-BAT</p>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-orbit">
            <div className="art-core"><div className="art-line" /><div className="art-line short" /><div className="art-line" /><div className="art-check"><Check size={13} /> Compte rendu enregistré</div></div>
            <div className="art-tag top"><MapPin size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} /> Site · Lyon 7e</div>
            <div className="art-tag bottom"><ShieldCheck size={13} style={{ verticalAlign: 'middle', marginRight: 5, color: '#B23D4F' }} /> Dossier suivi</div>
          </div>
        </div>
      </main>
      <section className="feature-band">
        <div className="feature"><span className="feature-num">01 / SAISIR</span><h3>Une fiche nette, dès le chantier</h3><p>Le site, le client et les zones d’intervention réunis dans un formulaire pensé pour le téléphone.</p></div>
        <div className="feature"><span className="feature-num">02 / RELIRE</span><h3>Les informations à vérifier ressortent</h3><p>Un dossier conserve son statut et ses éléments manquants pour faciliter la relecture par l’équipe.</p></div>
        <div className="feature"><span className="feature-num">03 / CLASSER</span><h3>Un suivi commun au terrain et au bureau</h3><p>Retrouvez les interventions, leurs observations et les versions de rapport générées.</p></div>
      </section>
    </div>
  </>;
}

// With Genspark identity there is no in-app sign-in form: the Genspark edge
// authenticates the visitor ("Sign in with Genspark" access mode). The legacy
// /sign-in and /sign-up routes redirect home so old links keep working.
function AuthPage(_props: { mode: 'in' | 'up' }) {
  return <Redirect to="/" />;
}

const links = [
  { href: '/portal', label: 'Vue d’ensemble', icon: Home },
  { href: '/reports', label: 'Interventions', icon: ClipboardList },
  { href: '/clients', label: 'Clients', icon: Users, manager: true },
  { href: '/sites', label: 'Sites', icon: Building2, manager: true },
  { href: '/admin/erased-names', label: 'Noms à effacer', icon: Eraser, admin: true },
  { href: '/settings', label: 'Mon compte', icon: Settings },
];

function Protected({ children }: { children: ReactNode }) {
  const { loaded, user } = useGensparkAuth();
  if (!loaded) return <div className="grid"><div className="loading-block" /></div>;
  if (!user) return <Redirect to="/" />;
  return <>{children}</>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const { data: user, error: profileError, refetch: refreshProfile } = useGetCurrentUser();
  const visibleLinks = links.filter((item) => (!item.manager || roleCanManage(user?.role)) && (!('admin' in item) || user?.role === 'administratif' || user?.role === 'direction'));
  if (profileError?.status === 401) {
    return <Protected><main className="main-content"><ErrorNotice error={profileError} retry={() => { void refreshProfile(); }} /></main></Protected>;
  }
  return <Protected><div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">MB</div><span>MSB-BAT<br /><small style={{ fontFamily: 'DM Sans', fontSize: 10, color: '#b8b5ce', fontWeight: 500, letterSpacing: '.03em' }}>RAPPORTS TERRAIN</small></span></div>
      <div className="nav-label">Espace de travail</div>
      {visibleLinks.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={`nav-link ${path === href || (href === '/reports' && path.startsWith('/reports')) ? 'active' : ''}`}><Icon size={17} strokeWidth={1.8} />{label}</Link>)}
      <div className="side-footer">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 13 }}>
          <div style={{ width: 35, height: 35, borderRadius: 12, background: '#46416f', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700 }}>{user?.name?.split(' ').map((part) => part[0]).join('').slice(0, 2) || 'MS'}</div>
          <div style={{ minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name || 'Compte MSB-BAT'}</div><div style={{ fontSize: 10, color: '#aaa7c4', marginTop: 3 }}>{roles[user?.role || ''] || 'Chargement du profil'}</div></div>
        </div>
        <button className="nav-link" style={{ width: '100%', border: 0, background: 'transparent', cursor: 'pointer' }} onClick={() => signOutGenspark()}><LogOut size={16} /> Se déconnecter</button>
      </div>
    </aside>
    <div className="main-area">
      <header className="topbar"><span className="crumb">MSB-BAT <span style={{ margin: '0 8px', color: '#c3b7bd' }}>/</span> {links.find((item) => item.href === path)?.label || (path.startsWith('/reports/') ? 'Fiche intervention' : 'Espace de travail')}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6d6682', fontSize: 12 }}><span style={{ width: 7, height: 7, background: '#60a98a', borderRadius: '50%' }} /> Connecté</span>
      </header>
      <div className="main-content">{children}</div>
    </div>
    <nav className="mobile-nav">{visibleLinks.filter((item) => !('admin' in item)).slice(0, 5).map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={path === href || (href === '/reports' && path.startsWith('/reports')) ? 'active' : ''}><Icon /><span>{label === 'Vue d’ensemble' ? 'Accueil' : label === 'Interventions' ? 'Rapports' : label}</span></Link>)}</nav>
  </div></Protected>;
}

export function Loading({ count = 3 }: { count?: number }) {
  return <div className="grid">{Array.from({ length: count }, (_, i) => <div key={i} className="loading-block" />)}</div>;
}
export function ErrorNotice({ retry, error }: { retry: () => void; error?: unknown }) {
  const sessionRejected = typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
  const timedOut = error instanceof Error && error.name === 'RequestTimeoutError';
  return <div className="panel empty" role="alert"><div className="empty-mark"><X size={19} /></div><strong>{sessionRejected ? 'Votre session doit être renouvelée' : 'Impossible de charger ces informations'}</strong><p style={{ margin: '8px 0 15px', fontSize: 13 }}>{sessionRejected ? 'Le serveur ne reconnaît plus cette session. Reconnectez-vous pour retrouver vos dossiers ; vos données sont conservées.' : timedOut ? 'Le chargement a pris trop de temps. Vos données sont conservées ; cliquez sur Réessayer pour relancer la demande.' : 'Le serveur n’a pas pu charger ces données. Réessayez dans quelques instants.'}</p><div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}><button onClick={retry} className="btn btn-soft">Réessayer</button>{sessionRejected && <button onClick={() => signOutGenspark()} className="btn btn-primary">Renouveler ma connexion</button>}</div></div>;
}
export function requestFailure(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    if (error.status === 401) return 'Votre session doit être renouvelée. Déconnectez-vous puis reconnectez-vous ; vos données sont conservées.';
    if (typeof error.status === 'number' && error.status >= 500) return 'Le service de rapports est momentanément indisponible. Votre saisie est conservée ; réessayez dans quelques instants.';
    if ('data' in error && typeof error.data === 'object' && error.data !== null && 'detail' in error.data && typeof error.data.detail === 'string') return error.data.detail;
  }
  return fallback;
}
export function Status({ status }: { status?: string }) {
  return <span className={`status status-${status || 'brouillon'}`} data-testid={`status-${status || 'brouillon'}`}>{statusLabels[status || ''] || status || 'Brouillon'}</span>;
}
export function PageHead({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="subtitle">{description}</p></div>{action}</div>;
}

function Portal() {
  const summary = useGetDashboardSummary();
  const userQuery = useGetCurrentUser();
  const user = userQuery.data;
  const data = summary.data;
  const count = (status: string) => data?.byStatus?.find((item) => item.status === status)?.count || 0;
  return <AppShell>
    {summary.isLoading ? <Loading /> : summary.isError ? <ErrorNotice error={summary.error} retry={() => summary.refetch()} /> : <>
      <PageHead eyebrow={new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} title={`Bonjour${user?.name ? `, ${user.name.split(' ')[0]}` : ''}.`} description="Voici les dossiers qui demandent votre attention." action={<Link href="/reports/new" className="btn btn-primary"><FilePlus2 size={16} /> Nouvelle intervention</Link>} />
      <div className="grid stats-grid">
        {[['Dossiers au total', data?.total || 0, ClipboardList], ['À vérifier', count('a_verifier'), ShieldCheck], ['À corriger', count('a_corriger'), ArrowDownRight], ['Prêts à envoyer', count('pret_a_envoyer'), FileText]].map(([label, value, Icon]: any) => <div className="panel stat" key={label}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative', zIndex: 1 }}><span className="stat-label">{label}</span><Icon size={17} color="#B23D4F" /></div><div className="stat-value">{value}</div></div>)}
      </div>
      <div className="panel panel-pad">
        <div className="row" style={{ marginBottom: 8 }}><div><div className="eyebrow">Suivi récent</div><h2 className="section-title">Dernières interventions</h2></div><Link href="/reports" className="btn btn-plain">Tout voir <ArrowRight size={14} /></Link></div>
        {data?.recent?.length ? data.recent.slice(0, 6).map((report) => <Link key={report.id} href={`/reports/${report.id}`} className="list-row" data-testid={`report-recent-${report.id}`}><div style={{ minWidth: 0 }}><strong style={{ fontSize: 13, display: 'block', marginBottom: 5 }}>{report.object}</strong><span style={{ color: '#817b98', fontSize: 11 }}>{report.clientName} · {report.siteName} · {new Date(report.date).toLocaleDateString('fr-FR')}</span></div><Status status={report.status} /></Link>) : <div className="empty"><div className="empty-mark"><ClipboardList size={19} /></div><strong>Aucune intervention récente</strong><p style={{ fontSize: 13 }}>Créez une fiche au démarrage de votre prochaine intervention.</p><Link href="/reports/new" className="btn btn-primary">Créer une fiche</Link></div>}
      </div>
    </>}
  </AppShell>;
}

function ImportButton() {
  const { data: user } = useGetCurrentUser();
  if (!roleCanManage(user?.role)) return null;
  return <Link href="/reports/import" className="btn btn-soft" data-testid="link-import-pdf"><FileUp size={16} /> Importer un PDF</Link>;
}

function Reports() {
  const navigationSearch = new URLSearchParams(useSearch());
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const params = useMemo(() => ({ ...(search ? { search } : {}), ...(status ? { status: status as any } : {}) }), [search, status]);
  const reports = useListReports(params, {
    query: { queryKey: getListReportsQueryKey(params), retry: 1, retryDelay: 1000 },
    request: { timeoutMs: 15000 },
  });
  const retryReports = () => { void queryClient.resetQueries({ queryKey: reports.queryKey, exact: true }); };
  return <AppShell>
    <PageHead eyebrow="Dossiers d’intervention" title="Interventions" description="Retrouvez les comptes rendus et suivez leur avancement." action={<div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}><ImportButton /><Link href="/reports/new" className="btn btn-primary"><Plus size={16} /> Nouvelle intervention</Link></div>} />
    {navigationSearch.get('deleted') === '1' && <div className="panel panel-pad" role="status" style={{ marginBottom: 16, color: '#24745a' }} data-testid="notice-report-deleted">
      Le rapport d’intervention a été supprimé.
      {navigationSearch.get('cleanupPending') === '1' && <p style={{ margin: '8px 0 0', color: '#805323', fontSize: 12 }}>Certains fichiers n’ont pas pu être effacés du stockage, mais ils ne sont plus accessibles dans l’application.</p>}
    </div>}
    <div className="toolbar">
      <div className="search-wrap"><Search size={16} /><input className="search-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Chercher un client, site ou objet…" aria-label="Rechercher des interventions" data-testid="input-search-reports" /></div>
      <div style={{ position: 'relative' }}><Filter size={14} style={{ position: 'absolute', left: 11, top: 14, color: '#817b98', pointerEvents: 'none' }} /><select className="search-input" style={{ paddingLeft: 33, minWidth: 175 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filtrer par statut" data-testid="select-status-filter"><option value="">Tous les statuts</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    </div>
    {reports.isLoading ? <ReportsLoading retry={retryReports} /> : reports.isError ? <ErrorNotice error={reports.error} retry={retryReports} /> : reports.data?.length ? <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,370px),1fr))' }}>
      {reports.data.map((report) => <Link href={`/reports/${report.id}`} key={report.id} className="panel report-card" data-testid={`report-card-${report.id}`}>
        <div className="date-tile"><strong>{new Date(report.date).getDate()}</strong><span>{new Date(report.date).toLocaleDateString('fr-FR', { month: 'short' })}</span></div>
        <div className="report-card-copy"><strong>{report.object}</strong><span>{report.clientName} · {report.siteName}</span><div style={{ marginTop: 8 }}><Status status={report.status} /></div></div>
        <ArrowRight size={16} color="#958da1" />
      </Link>)}
    </div> : <div className="panel empty"><div className="empty-mark"><Search size={19} /></div><strong>Aucun dossier correspondant</strong><p style={{ fontSize: 13 }}>Modifiez les filtres ou créez une nouvelle intervention.</p><Link href="/reports/new" className="btn btn-primary">Nouvelle intervention</Link></div>}
  </AppShell>;
}

function ReportsLoading({ retry }: { retry: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);
  return <div aria-live="polite"><Loading />{slow && <div className="panel panel-pad" style={{ textAlign: 'center', marginTop: 12 }}><p style={{ fontSize: 13 }}>Le chargement des interventions prend plus de temps que prévu.</p><button className="btn btn-soft" onClick={retry}>Relancer le chargement</button></div>}</div>;
}

function ReportCreate() {
  const [, setLocation] = useLocation();
  const sites = useListSites();
  const create = useCreateReport();
  const [form, setForm] = useState({ siteId: '', date: new Date().toISOString().slice(0, 10), tenant: '', object: '', workOrder: '', interventionState: 'en_cours' as 'en_cours' | 'realisee' });
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (!form.siteId) { setError('Sélectionnez un site pour rattacher le dossier.'); return; }
    create.mutate({ data: { ...form, tenant: form.tenant || undefined, workOrder: form.workOrder || undefined } }, {
      onSuccess: (report) => { queryClient.invalidateQueries({ queryKey: getListReportsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); setLocation(`/reports/${report.id}`); },
      onError: (failure) => setError(requestFailure(failure, 'La fiche n’a pas pu être créée. Votre saisie est conservée ; réessayez.')),
    });
  };
  return <AppShell><PageHead eyebrow="Nouvelle fiche" title="Démarrer une intervention" description="Renseignez les informations du site et de la mission." action={<div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}><ImportButton /><Link href="/reports" className="btn btn-plain"><ArrowLeft size={15} /> Retour</Link></div>} />
    <form className="panel panel-pad" onSubmit={submit} style={{ maxWidth: 800 }}>
      {sites.isLoading ? <Loading count={2} /> : sites.isError ? <ErrorNotice error={sites.error} retry={() => sites.refetch()} /> : <>
        <div className="form-grid">
          <div className="field"><label htmlFor="site">Site concerné</label><select id="site" required value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}><option value="">Choisir un site…</option>{sites.data?.filter((site) => site.active).map((site) => <option value={site.id} key={site.id}>{site.name} — {site.clientName}</option>)}</select></div>
          <div className="field"><label htmlFor="date">Date d’intervention</label><input id="date" type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="object">Objet de l’intervention · Facultatif</label><input id="object" placeholder="Ex. Maintenance préventive de la ventilation" value={form.object} onChange={(e) => setForm({ ...form, object: e.target.value })} /></div>
          <div className="field"><label htmlFor="tenant">Occupant / locataire <span style={{ fontWeight: 400, color: '#817b98' }}>· Facultatif</span></label><input id="tenant" value={form.tenant} onChange={(e) => setForm({ ...form, tenant: e.target.value })} placeholder="Nom de l’occupant" /></div>
          <div className="field"><label htmlFor="workOrder">Bon de travail <span style={{ fontWeight: 400, color: '#817b98' }}>· Facultatif</span></label><input id="workOrder" value={form.workOrder} onChange={(e) => setForm({ ...form, workOrder: e.target.value })} placeholder="Référence" /></div>
          <div className="field"><label htmlFor="intervention-state">Statut de l’intervention</label><select id="intervention-state" value={form.interventionState} onChange={(e) => setForm({ ...form, interventionState: e.target.value as 'en_cours' | 'realisee' })}><option value="en_cours">En cours</option><option value="realisee">Intervention réalisée</option></select></div>
        </div>
        {error && <p style={{ color: '#a23c4b', fontSize: 12, margin: '14px 0 0' }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 22 }}><Link href="/reports" className="btn btn-plain">Annuler</Link><button className="btn btn-primary" type="submit" disabled={create.isPending}>{create.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <FilePlus2 size={15} />} Créer la fiche</button></div>
      </>}
    </form>
  </AppShell>;
}

function ReportEditor() {
  const params = useParams<{ reportId: string }>();
  const reportId = params.reportId || '';
  const query = useGetReport(reportId, { query: { queryKey: getGetReportQueryKey(reportId), enabled: !!reportId } });
  const versions = useListReportVersions(reportId, { query: { queryKey: getListReportVersionsQueryKey(reportId), enabled: !!reportId } });
  const updateReport = useUpdateReport();
  const addZone = useCreateReportZone();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetReportQueryKey(reportId) });
  const createZone = () => addZone.mutate({ reportId, data: { name: `Zone ${query.data?.zones.length ? query.data.zones.length + 1 : 1}`, rawNotes: '' } }, { onSuccess: refresh });
  if (query.isLoading) return <AppShell><Loading count={4} /></AppShell>;
  if (query.isError || !query.data) return <AppShell><ErrorNotice retry={() => query.refetch()} /></AppShell>;
  const report = query.data;
  const updateMeta = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    setSaving(true); setError(''); updateReport.mutate({ reportId, data: { siteId: String(data.get('siteId')), date: String(data.get('date')), tenant: String(data.get('tenant')) || null, object: String(data.get('object')), workOrder: String(data.get('workOrder')) || null, interventionState: String(data.get('interventionState')) as 'en_cours' | 'realisee', conclusion: String(data.get('conclusion')).split('\n').map(line => line.trim()).filter(Boolean) } }, { onSuccess: () => { refresh(); queryClient.invalidateQueries({ queryKey: getListReportsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); setSaving(false); }, onError: (failure) => { setSaving(false); setError(requestFailure(failure, 'La fiche n’a pas pu être enregistrée.')); } });
  };
  return <AppShell>
    <PageHead eyebrow={`${report.clientName} · ${report.siteName}`} title="Fiche d’intervention" description="Ajoutez vos observations, photos et vérifiez les informations du dossier." action={<div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}><DeleteReportButton reportId={reportId} object={report.object} siteName={report.siteName} date={report.date} /><Link href="/reports" className="btn btn-plain"><ArrowLeft size={15} /> Archives</Link></div>} />
    {report.importPending || report.interventionDates?.length ? <div className="panel" style={{ background: '#efedfb', borderColor: '#d6d0f0', padding: 14, fontSize: 12, marginBottom: 14, display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}><span>{report.importPending ? 'Ce dossier provient d’un import PDF qui n’a pas encore été relu. La génération est bloquée.' : 'Ce dossier provient d’un import PDF.'}</span><Link href={`/reports/${reportId}/import-review`} className="btn btn-plain" data-testid="link-import-review"><FileUp size={15} /> Retour à la relecture</Link></div> : null}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 18 }}><Status status={report.status} />{report.missingFields?.length ? <span className="status status-a_corriger">{report.missingFields.length} élément(s) à compléter</span> : null}</div>
    {report.missingFields?.length ? <div className="panel" style={{ background: '#fff5e6', borderColor: '#f1d7aa', color: '#805323', padding: 14, fontSize: 12, marginBottom: 16 }}><strong>Informations manquantes</strong><span> · {report.missingFields.join(' · ')}. Vous pouvez générer le rapport sans tout renseigner, après confirmation de relecture s’il provient d’un import.</span></div> : null}
    <form className="panel panel-pad" onSubmit={updateMeta} style={{ marginBottom: 18 }}>
      <div className="row" style={{ marginBottom: 17 }}><h2 className="section-title">Informations générales</h2><button className="btn btn-soft" disabled={saving}>{saving ? 'Enregistrement…' : 'Enregistrer'}</button></div>
      <div className="form-grid">
        <div className="field"><label>Date</label><input type="date" name="date" defaultValue={report.date} /></div>
        <div className="field"><label>Objet · Facultatif</label><input name="object" defaultValue={report.object} /></div>
        <div className="field"><label>Occupant / locataire</label><input name="tenant" defaultValue={report.tenant || ''} /></div>
        <div className="field"><label>Bon de travail</label><input name="workOrder" defaultValue={report.workOrder || ''} /></div>
        <div className="field"><label htmlFor="report-intervention-state">2. Statut de l’intervention</label><select id="report-intervention-state" name="interventionState" defaultValue={report.interventionState || 'en_cours'}><option value="en_cours">En cours</option><option value="realisee">Intervention réalisée</option></select><small>Ce statut apparaît dans le PDF ; il est distinct de la validation du dossier.</small></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="report-conclusion">4. Conclusion — un point par ligne</label><textarea id="report-conclusion" name="conclusion" defaultValue={(report.conclusion || []).join('\n')} placeholder="Renseignez la conclusion du chantier, comme dans votre modèle." /></div>
        <input type="hidden" name="siteId" value={report.siteId} />
      </div>
      {error && <p style={{ color: '#a23c4b', fontSize: 12, marginTop: 12 }}>{error}</p>}
    </form>
    <div className="row" style={{ marginBottom: 13 }}><div><div className="eyebrow">Contexte, constats et travaux</div><h2 className="section-title">3. Description de l’intervention</h2></div><button onClick={createZone} className="btn btn-primary" disabled={addZone.isPending}><Plus size={15} /> Ajouter une zone</button></div>
    {report.zones?.length ? <div className="grid">{report.zones.map((zone) => <ZoneEditor key={zone.id} reportId={reportId} zone={zone} refresh={refresh} />)}</div> : <div className="panel empty"><div className="empty-mark"><Wrench size={19} /></div><strong>Pas encore de zone</strong><p style={{ fontSize: 13 }}>Ajoutez une zone pour consigner vos observations.</p><button className="btn btn-primary" onClick={createZone}><Plus size={15} /> Ajouter une zone</button></div>}
    <div className="panel panel-pad" style={{ marginTop: 20 }}>
      <div className="row"><div><div className="eyebrow">Contrôle et transmission</div><h2 className="section-title">Versions du rapport</h2></div><PdfAction reportId={reportId} blocked={!!report.importPending} /></div>
      {versions.isLoading ? <div className="loading-block" style={{ marginTop: 16 }} /> : versions.isError ? <ErrorNotice retry={() => versions.refetch()} /> : versions.data?.length ? versions.data.map((v) => <div key={v.id} className="list-row"><div><strong style={{ fontSize: 13 }}>Version {v.version} · {v.fileName}</strong><div style={{ fontSize: 11, color: '#817b98', marginTop: 5 }}>{new Date(v.createdAt).toLocaleString('fr-FR')} · {v.compliant ? 'Conforme' : `${v.issues.length} point(s) à revoir`}</div></div><a className="btn btn-plain" href={v.downloadUrl} target="_blank" rel="noreferrer">Ouvrir</a></div>) : <p style={{ color: '#817b98', fontSize: 12, margin: '18px 0 0' }}>Aucune version générée pour le moment.</p>}
    </div>
    <StatusActions reportId={reportId} status={report.status} />
  </AppShell>;
}

function ZoneEditor({ reportId, zone, refresh }: { reportId: string; zone: any; refresh: () => void }) {
  const update = useUpdateReportZone();
  const format = useFormatReportZone();
  const apply = useApplyReportZoneFormat();
  const requestUpload = useRequestReportPhotoUpload();
  const createPhoto = useCreateReportPhoto();
  const updatePhoto = useUpdateReportPhoto();
  const [proposal, setProposal] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [photoGroup, setPhotoGroup] = useState('');
  const [notice, setNotice] = useState('');
  const updateZone = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    setNotice(''); update.mutate({ reportId, zoneId: zone.id, data: { name: String(form.get('name')), rawNotes: String(form.get('rawNotes')), context: String(form.get('context')) || null, findings: String(form.get('findings')).split('\n').map(line => line.trim()).filter(Boolean), workDone: String(form.get('workDone')).split('\n').map(line => line.trim()).filter(Boolean) } }, { onSuccess: () => { refresh(); setNotice('Description enregistrée.'); }, onError: (failure) => setNotice(requestFailure(failure, 'Enregistrement impossible, réessayez.')) });
  };
  const optimize = async (file: File) => {
    const image = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas indisponible');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close();
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Compression impossible')), 'image/jpeg', .82));
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  };
  const uploadPhotos = async (files: File[]) => {
    if (!files.length || uploading) return;
    setUploading(true); setNotice('');
    const groupTitle = photoGroup.trim() || undefined;
    const failures: string[] = [];
    let added = 0;
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress({ current: index + 1, total: files.length });
        try {
          const jpeg = await optimize(file);
          const target = await requestUpload.mutateAsync({ reportId, data: { fileName: jpeg.name, contentType: 'image/jpeg', size: jpeg.size } });
          const uploaded = await fetch(target.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg });
          if (!uploaded.ok) throw new Error('Upload failed');
          await createPhoto.mutateAsync({ reportId, data: { zoneId: zone.id, objectPath: target.objectPath, category: 'autre', groupTitle } });
          added++;
        } catch { failures.push(file.name); }
      }
      refresh();
      setNotice(failures.length
        ? `${added} photo(s) ajoutée(s). Échec pour : ${failures.join(', ')}. Sélectionnez uniquement ces fichiers pour réessayer.`
        : `${added} photo(s) ajoutée(s) au dossier.`);
    }
    finally { setUploading(false); }
  };
  const askFormat = () => format.mutate({ reportId, zoneId: zone.id }, { onSuccess: setProposal, onError: () => setNotice('La proposition de mise en forme est indisponible.') });
  return <section className="panel panel-pad">
    <form onSubmit={updateZone} key={`${zone.context}:${JSON.stringify(zone.findings)}:${JSON.stringify(zone.workDone)}`}>
      <div className="row" style={{ marginBottom: 15 }}><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="empty-mark" style={{ margin: 0, width: 33, height: 33, borderRadius: 10 }}><MapPin size={16} /></div><div><div className="eyebrow" style={{ margin: 0 }}>Zone {zone.order + 1}</div><div style={{ fontWeight: 700, fontSize: 14 }}>{zone.name}</div></div></div><button className="btn btn-soft" type="submit" disabled={update.isPending}>{update.isPending ? 'Enregistrement…' : 'Enregistrer'}</button></div>
      <div className="form-grid">
        <div className="field"><label>Nom de la zone</label><input name="name" defaultValue={zone.name} required /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Contexte</label><textarea name="context" defaultValue={zone.context || ''} placeholder="Décrivez le contexte de l’intervention, comme dans votre modèle." /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes prises sur place</label><textarea name="rawNotes" defaultValue={zone.rawNotes || ''} placeholder="Décrivez simplement ce que vous avez observé ou réalisé…" /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Constats du rapport — un constat par ligne</label><textarea name="findings" defaultValue={(zone.findings || []).join('\n')} placeholder="Saisissez ou corrigez les constats à inclure dans le PDF." /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Intervention réalisée — une action par ligne</label><textarea name="workDone" defaultValue={(zone.workDone || []).join('\n')} placeholder="Décrivez uniquement les travaux effectivement réalisés." /></div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', marginTop: 14 }}>
        <div className="field" style={{ flex: '1 1 260px' }}><label htmlFor={`photo-group-${zone.id}`}>5. Reportage photographique — titre du groupe</label><input id={`photo-group-${zone.id}`} value={photoGroup} onChange={(e) => setPhotoGroup(e.target.value)} placeholder="Ex. Fouille et état avant travaux" /><small>Les prochaines photos seront regroupées sous ce titre dans le PDF. Sans titre, le nom de la zone est utilisé.</small></div>
        <button className="btn btn-plain" type="button" onClick={askFormat} disabled={format.isPending}><Sparkles size={15} /> {format.isPending ? 'Préparation…' : 'Prévisualiser la mise en forme'}</button>
        <label className="btn btn-soft" style={{ cursor: uploading ? 'wait' : 'pointer' }}><Camera size={15} />{uploading ? `Envoi ${uploadProgress.current}/${uploadProgress.total}…` : 'Ajouter des photos'}<input type="file" accept="image/*" multiple hidden disabled={uploading} data-testid={`input-photos-${zone.id}`} onChange={(e) => { const files = Array.from(e.target.files || []); e.currentTarget.value = ''; void uploadPhotos(files); }} /></label>
      </div>
      {proposal && <div style={{ marginTop: 17, padding: 16, background: '#fbf7f7', border: '1px solid #eadde0', borderRadius: 12 }}>
        <div className="row"><strong style={{ fontSize: 13, display: 'flex', gap: 7, alignItems: 'center' }}><Sparkles size={14} color="#B23D4F" /> Proposition à relire</strong><button type="button" className="icon-button" onClick={() => setProposal(null)} aria-label="Fermer la proposition"><X size={15} /></button></div>
        {proposal.context && <p style={{ fontSize: 12, lineHeight: 1.6, margin: '12px 0' }}>{proposal.context}</p>}
        {!!proposal.findings?.length && <ul style={{ fontSize: 12, lineHeight: 1.7, paddingLeft: 18, margin: '8px 0' }}>{proposal.findings.map((finding: string, i: number) => <li key={i}>{finding}</li>)}</ul>}
        {!!proposal.workDone?.length && <><strong style={{ fontSize: 12 }}>Intervention réalisée</strong><ul style={{ fontSize: 12, lineHeight: 1.7, paddingLeft: 18 }}>{proposal.workDone.map((work: string, i: number) => <li key={i}>{work}</li>)}</ul></>}
        {!!proposal.alerts?.length && <p style={{ color: '#a23c4b', fontSize: 12 }}>À relire : {proposal.alerts.join(' · ')}</p>}
        {!!proposal.missing?.length && <p style={{ color: '#805323', fontSize: 12 }}>Informations manquantes : {proposal.missing.join(' · ')}</p>}
        <button type="button" className="btn btn-primary" onClick={() => apply.mutate({ reportId, zoneId: zone.id, data: proposal }, { onSuccess: () => { setProposal(null); refresh(); }, onError: () => setNotice('La proposition n’a pas été appliquée.') })} disabled={apply.isPending}><Check size={15} />{apply.isPending ? 'Application…' : 'Appliquer cette proposition'}</button>
      </div>}
      {!!zone.photos?.length && <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 9 }}>{zone.photos.map((photo: any) => <PhotoChip key={photo.id} photo={photo} reportId={reportId} updatePhoto={updatePhoto} refresh={refresh} />)}</div>}
      {notice && <div role="status" style={{ marginTop: 11, fontSize: 12, color: notice.startsWith('La') || notice.includes('Échec') ? '#a23c4b' : '#24745a' }}>{notice}</div>}
    </form>
  </section>;
}

function PhotoChip({ photo, reportId, updatePhoto, refresh }: { photo: any; reportId: string; updatePhoto: any; refresh: () => void }) {
  const [notice, setNotice] = useState('');
  const save = (field: 'caption' | 'groupTitle', value: string) => {
    if ((photo[field] || '') === value) return;
    setNotice('');
    updatePhoto.mutate({ reportId, photoId: photo.id, data: { [field]: value || null } }, {
      onSuccess: () => { refresh(); setNotice('Enregistré'); },
      onError: (failure: unknown) => setNotice(requestFailure(failure, 'Modification non enregistrée. Réessayez.')),
    });
  };
  return <div style={{ width: 160, background: '#fff', border: '1px solid #eadde0', borderRadius: 10, overflow: 'hidden' }}>
    <a href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} alt={photo.caption || 'Photo de l’intervention'} style={{ width: '100%', height: 100, objectFit: 'cover' }} /></a>
    <div style={{ padding: 9 }}><div style={{ fontSize: 10, fontWeight: 700, marginBottom: 6 }}>Photo privée</div><input aria-label="Groupe de la photo" placeholder="Titre du groupe" defaultValue={photo.groupTitle || ''} onBlur={(e) => save('groupTitle', e.target.value.trim())} style={{ width: '100%', border: '1px solid #eee5e8', borderRadius: 6, padding: 6, fontSize: 10, marginBottom: 6 }} /><input aria-label="Légende de la photo" placeholder="Légende facultative" defaultValue={photo.caption || ''} onBlur={(e) => save('caption', e.target.value)} style={{ width: '100%', border: '1px solid #eee5e8', borderRadius: 6, padding: 6, fontSize: 10 }} />{notice && <small role="status">{notice}</small>}</div>
  </div>;
}

function PdfAction({ reportId, blocked = false }: { reportId: string; blocked?: boolean }) {
  const generate = useGenerateReportPdf();
  const versions = useListReportVersions(reportId);
  const [message, setMessage] = useState('');
  return <div style={{ textAlign: 'right' }}><button className="btn btn-primary" onClick={() => generate.mutate({ reportId }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListReportVersionsQueryKey(reportId) }); setMessage('Nouvelle version créée.'); }, onError: (failure) => setMessage(requestFailure(failure, 'La génération du rapport a échoué.')) })} disabled={generate.isPending || blocked} title={blocked ? 'Relisez l’import avant de générer' : undefined}><FileText size={15} />{generate.isPending ? 'Génération…' : 'Générer une version'}</button>{message && <div role="status" style={{ fontSize: 11, marginTop: 5 }}>{message}</div>}{versions.isFetching && <span style={{ display: 'none' }} />}</div>;
}

function StatusActions({ reportId, status }: { reportId: string; status: string }) {
  const transition = useTransitionReportStatus();
  const choices: Record<string, string[]> = { brouillon: ['a_verifier'], a_verifier: ['a_corriger', 'valide'], a_corriger: ['a_verifier'], valide: ['pret_a_envoyer'], pret_a_envoyer: ['envoye'], envoye: [] };
  const available = choices[status] || [];
  if (!available.length) return null;
  return <div className="panel panel-pad" style={{ marginTop: 18 }}><div className="row"><div><div className="eyebrow">Prochaine étape</div><h2 className="section-title">Faire avancer le dossier</h2></div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{available.map((next) => <button key={next} className="btn btn-soft" disabled={transition.isPending} onClick={() => transition.mutate({ reportId, data: { status: next as any } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetReportQueryKey(reportId) }); queryClient.invalidateQueries({ queryKey: getListReportsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); } })}>Passer à « {statusLabels[next]} » <ArrowRight size={14} /></button>)}</div></div></div>;
}

function Clients() {
  const query = useListClients();
  const create = useCreateClient();
  const update = useUpdateClient();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!name.trim()) return; create.mutate({ data: { name: name.trim() } }, { onSuccess: () => { setName(''); invalidate(); } }); };
  return <AppShell><PageHead eyebrow="Référentiel" title="Clients" description="Les organisations rattachées aux sites d’intervention." />
    <form className="panel panel-pad" onSubmit={submit} style={{ marginBottom: 18, display: 'flex', gap: 10 }}><input className="search-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du nouveau client" aria-label="Nom du nouveau client" /><button className="btn btn-primary" disabled={create.isPending}><Plus size={15} /> Ajouter</button></form>
    <div className="toolbar"><div className="search-wrap"><Search size={16} /><input className="search-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filtrer les clients…" /></div></div>
    {query.isLoading ? <Loading /> : query.isError ? <ErrorNotice retry={() => query.refetch()} /> : <div className="panel panel-pad">{query.data?.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())).map((client) => <div className="list-row" key={client.id}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}><div className="empty-mark" style={{ margin: 0 }}><Building2 size={18} /></div><div>{editing === client.id ? <input className="search-input" value={draft} onChange={(e) => setDraft(e.target.value)} /> : <strong style={{ display: 'block', fontSize: 13 }}>{client.name}</strong>}<span style={{ color: '#817b98', fontSize: 11 }}>{client.siteCount} site(s) · {client.active ? 'Actif' : 'Inactif'}</span></div></div>
      {editing === client.id ? <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-primary" onClick={() => update.mutate({ clientId: client.id, data: { name: draft } }, { onSuccess: () => { setEditing(null); invalidate(); } })}>Enregistrer</button><button type="button" className="icon-button" onClick={() => setEditing(null)}><X size={15} /></button></div> : <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-plain" onClick={() => { setEditing(client.id); setDraft(client.name); }}>Modifier</button><button type="button" className="btn btn-plain" onClick={() => update.mutate({ clientId: client.id, data: { active: !client.active } }, { onSuccess: invalidate })}>{client.active ? 'Désactiver' : 'Réactiver'}</button></div>}
    </div>)}{!query.data?.length && <div className="empty"><div className="empty-mark"><Users size={19} /></div><strong>Aucun client pour l’instant</strong></div>}</div>}
  </AppShell>;
}

function Sites() {
  const query = useListSites();
  const clients = useListClients();
  const create = useCreateSite();
  const update = useUpdateSite();
  const [form, setForm] = useState({ clientId: '', name: '', address: '', tenant: '' });
  const [search, setSearch] = useState('');
  const [editId, setEditId] = useState('');
  const [edit, setEdit] = useState({ name: '', address: '', tenant: '' });
  const invalidate = () => { queryClient.invalidateQueries({ queryKey: getListSitesQueryKey() }); queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() }); };
  const submit = (e: FormEvent) => { e.preventDefault(); if (!form.clientId) return; create.mutate({ data: { ...form, tenant: form.tenant || undefined } }, { onSuccess: () => { setForm({ clientId: '', name: '', address: '', tenant: '' }); invalidate(); } }); };
  return <AppShell><PageHead eyebrow="Référentiel" title="Sites" description="Adresses et occupants des lieux d’intervention." />
    <form className="panel panel-pad" onSubmit={submit} style={{ marginBottom: 18 }}>
      <div className="form-grid">
        <div className="field"><label>Client</label><select value={form.clientId} required onChange={(e) => setForm({ ...form, clientId: e.target.value })}><option value="">Choisir un client…</option>{clients.data?.filter((c) => c.active).map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></div>
        <div className="field"><label>Nom du site</label><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nom du bâtiment" /></div>
        <div className="field"><label>Adresse</label><input required value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Adresse complète" /></div>
        <div className="field"><label>Occupant / locataire</label><input value={form.tenant} onChange={(e) => setForm({ ...form, tenant: e.target.value })} placeholder="Facultatif" /></div>
      </div><div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}><button className="btn btn-primary" disabled={create.isPending}><Plus size={15} /> Ajouter un site</button></div>
    </form>
    <div className="toolbar"><div className="search-wrap"><Search size={16} /><input className="search-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Chercher un site, client ou adresse…" /></div></div>
    {query.isLoading ? <Loading /> : query.isError ? <ErrorNotice retry={() => query.refetch()} /> : <div className="panel panel-pad">{query.data?.filter((site) => `${site.name} ${site.clientName} ${site.address}`.toLowerCase().includes(search.toLowerCase())).map((site) => <div className="list-row" key={site.id}>
      <div style={{ minWidth: 0, flex: 1 }}>{editId === site.id ? <div className="form-grid"><input className="search-input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /><input className="search-input" value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /><input className="search-input" value={edit.tenant} onChange={(e) => setEdit({ ...edit, tenant: e.target.value })} placeholder="Occupant" /></div> : <><strong style={{ fontSize: 13, display: 'block', marginBottom: 5 }}>{site.name}</strong><span style={{ color: '#817b98', fontSize: 11 }}>{site.clientName} · {site.address}{site.tenant ? ` · ${site.tenant}` : ''}</span></>}</div>
      {editId === site.id ? <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-primary" onClick={() => update.mutate({ siteId: site.id, data: edit }, { onSuccess: () => { setEditId(''); invalidate(); } })}>Enregistrer</button><button type="button" className="icon-button" onClick={() => setEditId('')}><X size={15} /></button></div> : <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-plain" onClick={() => { setEditId(site.id); setEdit({ name: site.name, address: site.address, tenant: site.tenant || '' }); }}>Modifier</button><button type="button" className="btn btn-plain" onClick={() => update.mutate({ siteId: site.id, data: { active: !site.active } }, { onSuccess: invalidate })}>{site.active ? 'Désactiver' : 'Réactiver'}</button></div>}
    </div>)}</div>}
  </AppShell>;
}

function SettingsPage() {
  const query = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const user = query.data;
  return <AppShell><PageHead eyebrow="Préférences" title="Mon compte" description="Votre identité et votre niveau d’accès MSB-BAT." />
    {query.isLoading ? <Loading count={2} /> : query.isError ? <ErrorNotice retry={() => query.refetch()} /> : <div className="panel panel-pad" style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 15, paddingBottom: 22, borderBottom: '1px solid #f0e8ea' }}><div className="empty-mark" style={{ width: 54, height: 54, borderRadius: 17, margin: 0 }}><UserRound size={23} /></div><div><h2 className="section-title">{user?.name}</h2><div style={{ fontSize: 12, color: '#817b98', marginTop: 5 }}>{user?.email}</div></div></div>
      <div className="list-row"><div><div className="eyebrow" style={{ marginBottom: 5 }}>Rôle attribué</div><strong style={{ fontSize: 13 }}>{roles[user?.role || ''] || user?.role}</strong></div><span className="status status-valide"><ShieldCheck size={12} /> Accès actif</span></div>
      <p style={{ fontSize: 12, lineHeight: 1.6, color: '#817b98', margin: '17px 0 0' }}>Les autorisations disponibles dans votre espace dépendent du rôle défini pour votre compte.</p>
    </div>}
  </AppShell>;
}

function HomeRedirect() {
  const { loaded, user } = useGensparkAuth();
  if (!loaded) return null;
  return user ? <Redirect to="/portal" /> : <Landing />;
}
function GensparkRoutes() {
  return <QueryClientProvider client={queryClient}>
      <GensparkQueryClientCacheInvalidator />
      <Switch>
        <Route path="/" component={HomeRedirect} />
        <Route path="/sign-in/*?" component={() => <AuthPage mode="in" />} />
        <Route path="/sign-up/*?" component={() => <AuthPage mode="up" />} />
        <Route path="/portal" component={Portal} />
        <Route path="/clients" component={Clients} />
        <Route path="/sites" component={Sites} />
        <Route path="/reports" component={Reports} />
        <Route path="/reports/new" component={ReportCreate} />
        <Route path="/reports/import" component={ImportPage} />
        <Route path="/admin/erased-names" component={ErasedNamesPage} />
        <Route path="/reports/:reportId/import-review" component={ImportReviewPage} />
        <Route path="/reports/:reportId" component={ReportEditor} />
        <Route path="/settings" component={SettingsPage} />
        <Route><NotFound /></Route>
      </Switch>
    </QueryClientProvider>;
}
function GensparkQueryClientCacheInvalidator() {
  const { user } = useGensparkAuth();
  const client = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const userId = user?.id ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) client.clear();
    previousUserId.current = userId;
  }, [user, client]);
  return null;
}
function NotFound() {
  return <AppShell><div className="panel empty"><div className="empty-mark"><FileText size={19} /></div><h2 className="section-title">Cette page n’existe pas</h2><p style={{ fontSize: 13 }}>La page demandée est introuvable.</p><Link href="/portal" className="btn btn-primary">Retour à l’espace</Link></div></AppShell>;
}

function App() {
  const [auth, setAuth] = useState<AuthState>({ loaded: false, user: null });
  useEffect(() => {
    let active = true;
    fetchGensparkUser().then((user) => { if (active) setAuth({ loaded: true, user }); });
    return () => { active = false; };
  }, []);
  return <WouterRouter base={basePath}>
    <GensparkAuthContext.Provider value={auth}>
      <GensparkRoutes />
    </GensparkAuthContext.Provider>
  </WouterRouter>;
}

export default App;
