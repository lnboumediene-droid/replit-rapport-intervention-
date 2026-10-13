import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Download, ExternalLink, Eraser, FileText, FileUp,
  LoaderCircle, Plus, RotateCcw, Save, Trash2, Undo2, X,
} from 'lucide-react';
import {
  useGetCurrentUser, useListSites, useRequestPdfImportUpload, useStartPdfImport,
  useGetPdfImport, getGetPdfImportQueryKey, useRetryPdfImport, useSavePdfImportReview,
  useGetReport, getGetReportQueryKey, useGenerateReportPdf, useListReportVersions,
  getListReportVersionsQueryKey, getListReportsQueryKey,
  useListErasedNames, getListErasedNamesQueryKey, useAddErasedName, useDeleteErasedName,
} from '@workspace/api-client-react';
import type { PdfImport, Report } from '@workspace/api-client-react';
import { AppShell, Loading, ErrorNotice, PageHead, queryClient, roleCanManage, requestFailure } from './App';

const MAX_SIZE = 30 * 1024 * 1024;
const MARKER = /\[\s*À COMPLÉTER\s*\]/i;
const lines = (v: string) => v.split('\n').map((l) => l.trim()).filter(Boolean);
const bad = (v: string) => !v.trim() || MARKER.test(v);

function Forbidden({ text }: { text: string }) {
  return <AppShell><div className="panel empty" data-testid="screen-forbidden"><div className="empty-mark"><X size={19} /></div><h2 className="section-title">Accès non autorisé</h2><p style={{ fontSize: 13, maxWidth: 440, margin: '8px auto 16px' }}>{text}</p><Link href="/reports" className="btn btn-primary">Retour aux interventions</Link></div></AppShell>;
}

/* ---------- Upload ---------- */
function putWithProgress(url: string, file: File, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Le dépôt du fichier a été refusé (code ${xhr.status}).`)));
    xhr.onerror = () => reject(new Error('Connexion interrompue pendant le dépôt du fichier.'));
    xhr.send(file);
  });
}

export function ImportPage() {
  const [, setLocation] = useLocation();
  const user = useGetCurrentUser();
  const sites = useListSites();
  const requestUpload = useRequestPdfImportUpload();
  const start = useStartPdfImport();
  const [clientId, setClientId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'upload' | 'start'>('idle');
  const [error, setError] = useState('');

  const activeSites = useMemo(() => (sites.data || []).filter((s) => s.active), [sites.data]);
  const clients = useMemo(() => {
    const map = new Map<string, string>();
    activeSites.forEach((s) => map.set(s.clientId, s.clientName));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [activeSites]);
  const shown = activeSites.filter((s) => !clientId || s.clientId === clientId);

  if (user.isLoading) return <AppShell><Loading count={2} /></AppShell>;
  if (user.data && !roleCanManage(user.data.role)) return <Forbidden text="L’import d’un rapport PDF est réservé aux responsables terrain, à l’administration et à la direction." />;

  const pick = (f?: File) => {
    setError('');
    if (!f) { setFile(null); return; }
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) { setError('Seuls les fichiers PDF sont acceptés.'); setFile(null); return; }
    if (f.size > MAX_SIZE) { setError('Ce fichier dépasse 30 Mo. Réduisez-le avant de le déposer.'); setFile(null); return; }
    if (f.size === 0) { setError('Ce fichier est vide.'); setFile(null); return; }
    setFile(f);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    if (!siteId || !file) { setError('Choisissez un site et un fichier PDF.'); return; }
    try {
      setPhase('upload'); setProgress(0);
      const target = await requestUpload.mutateAsync({ data: { fileName: file.name, contentType: 'application/pdf', size: file.size } });
      await putWithProgress(target.uploadUrl, file, setProgress);
      setProgress(100); setPhase('start');
      const res = await start.mutateAsync({ data: { importId: target.importId, siteId } });
      queryClient.invalidateQueries({ queryKey: getListReportsQueryKey() });
      setLocation(`/reports/${res.reportId}/import-review`);
    } catch (failure) {
      setPhase('idle');
      setError(failure instanceof Error && !('status' in failure) ? failure.message : requestFailure(failure, 'L’import n’a pas pu démarrer. Réessayez.'));
    }
  };
  const busy = phase !== 'idle';
  return <AppShell>
    <PageHead eyebrow="Rapport de sous-traitant" title="Importer un PDF" description="Déposez le rapport reçu. Les informations et les photos seront extraites, puis vous relirez le dossier avant toute génération." action={<Link href="/reports" className="btn btn-plain"><ArrowLeft size={15} /> Retour</Link>} />
    <form className="panel panel-pad" style={{ maxWidth: 800 }} onSubmit={submit}>
      {sites.isLoading ? <Loading count={2} /> : sites.isError ? <ErrorNotice error={sites.error} retry={() => sites.refetch()} /> : <>
        <div className="form-grid">
          <div className="field"><label htmlFor="imp-client">Client</label><select id="imp-client" value={clientId} disabled={busy} onChange={(e) => { setClientId(e.target.value); setSiteId(''); }} data-testid="select-import-client"><option value="">Tous les clients</option>{clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
          <div className="field"><label htmlFor="imp-site">Site concerné</label><select id="imp-site" value={siteId} disabled={busy} onChange={(e) => setSiteId(e.target.value)} data-testid="select-import-site"><option value="">Choisir un site…</option>{shown.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.clientName}</option>)}</select></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="imp-file">Fichier PDF <span style={{ fontWeight: 400, color: '#817b98' }}>· 30 Mo maximum, conservé en privé</span></label>
            <input id="imp-file" type="file" accept="application/pdf,.pdf" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} data-testid="input-import-file" />
            {file && <small>{file.name} · {(file.size / 1048576).toFixed(1)} Mo</small>}
          </div>
        </div>
        {busy && <div style={{ marginTop: 18 }} data-testid="import-progress"><div className="imp-bar"><div style={{ width: `${phase === 'start' ? 100 : progress}%` }} /></div><p style={{ fontSize: 12, color: '#6d6682', margin: '8px 0 0' }}>{phase === 'upload' ? `Dépôt du fichier… ${progress} %` : 'Lancement de la lecture du PDF…'}</p></div>}
        {error && <p role="alert" style={{ color: '#a23c4b', fontSize: 12, margin: '14px 0 0' }} data-testid="text-import-error">{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 22 }}><Link href="/reports" className="btn btn-plain">Annuler</Link><button className="btn btn-primary" type="submit" disabled={busy || !file || !siteId} data-testid="button-start-import">{busy ? <LoaderCircle className="animate-spin" size={15} /> : <FileUp size={15} />} Lancer l’import</button></div>
      </>}
    </form>
  </AppShell>;
}

/* ---------- Review ---------- */
type PhotoState = { id: string; url: string; groupTitle: string; caption: string; deleted: boolean };

function Fld({ label, bad: isBad, children, wide = true, hint }: { label: string; bad?: boolean; children: ReactNode; wide?: boolean; hint?: string }) {
  return <div className={`field ${isBad ? 'imp-bad' : ''}`} style={wide ? { gridColumn: '1 / -1' } : undefined}>
    <label>{label} {isBad && <span className="imp-tag">[À COMPLÉTER]</span>}</label>{children}{hint && <small>{hint}</small>}
  </div>;
}

export function ImportReviewPage() {
  const { reportId = '' } = useParams<{ reportId: string }>();
  const user = useGetCurrentUser();
  const imp = useGetPdfImport(reportId, {
    query: {
      queryKey: getGetPdfImportQueryKey(reportId), enabled: !!reportId,
      refetchInterval: (q) => { const st = q.state.data?.status; return st === 'processing' || st === 'uploaded' ? 2000 : false; },
    },
  });
  const status = imp.data?.status;
  // Analysis writes the report independently of the import-status query. A
  // separate key per status plus a fresh read prevents the review form from
  // initializing its local state with the pre-analysis cached report.
  const report = useGetReport(reportId, {
    query: {
      queryKey: [...getGetReportQueryKey(reportId), 'import-review', status],
      enabled: !!reportId && (status === 'ready' || status === 'failed'),
      staleTime: 0,
      refetchOnMount: 'always',
      retry: 1,
    },
    request: { timeoutMs: 15000 },
  });

  if (user.data && !roleCanManage(user.data.role)) return <Forbidden text="La relecture d’un import PDF est réservée aux responsables terrain, à l’administration et à la direction." />;
  if (imp.isLoading) return <AppShell><Loading count={3} /></AppShell>;
  if (imp.isError || !imp.data) return <AppShell><ErrorNotice error={imp.error} retry={() => imp.refetch()} /></AppShell>;
  const data = imp.data;
  const head = <PageHead eyebrow={`Import · ${data.fileName}`} title="Relecture de l’import" description={`Déposé par ${data.createdByName} le ${new Date(data.createdAt).toLocaleString('fr-FR')}.`} action={<Link href={`/reports/${reportId}`} className="btn btn-plain"><ArrowLeft size={15} /> Fiche du dossier</Link>} />;

  if (data.status === 'processing' || data.status === 'uploaded') {
    return <AppShell>{head}<div className="panel empty" data-testid="import-processing"><div className="empty-mark"><LoaderCircle className="animate-spin" size={19} /></div><strong>Lecture du PDF en cours</strong><p style={{ fontSize: 13, maxWidth: 440, margin: '8px auto 0' }}>Extraction du texte, nettoyage et remplissage de la fiche. Cette page se met à jour automatiquement.</p></div></AppShell>;
  }
  if (report.isLoading || !report.isFetchedAfterMount && !report.isError) return <AppShell>{head}<Loading count={3} /></AppShell>;
  if (report.isError || !report.data) return <AppShell>{head}<ErrorNotice error={report.error} retry={() => report.refetch()} /></AppShell>;
  return <AppShell>{head}<ReviewWorkspace key={`${reportId}:${status}`} reportId={reportId} imp={data} report={report.data} /></AppShell>;
}

function ReviewWorkspace({ reportId, imp, report }: { reportId: string; imp: PdfImport; report: Report }) {
  const sites = useListSites();
  const retry = useRetryPdfImport();
  const save = useSavePdfImportReview();
  const generate = useGenerateReportPdf();
  const versions = useListReportVersions(reportId, { query: { queryKey: getListReportVersionsQueryKey(reportId) } });
  const failed = imp.status === 'failed';

  const init = useMemo(() => {
    const zones = report.zones || [];
    const photos = zones.flatMap((z) => z.photos).sort((a, b) => a.order - b.order);
    return {
      dates: report.interventionDates?.length ? report.interventionDates : [''],
      photos: photos.map((p): PhotoState => ({ id: p.id, url: p.url, groupTitle: p.groupTitle || '', caption: p.caption || '', deleted: false })),
      context: zones.map((z) => z.context || '').filter(Boolean).join('\n'),
      findings: zones.flatMap((z) => z.findings).join('\n'),
      workDone: zones.flatMap((z) => z.workDone || []).join('\n'),
    };
  }, [report]);
  const [siteId, setSiteId] = useState(report.siteId);
  const [dates, setDates] = useState<string[]>(init.dates);
  const [object, setObject] = useState(report.object || '');
  const [tenant, setTenant] = useState(report.tenant || '');
  const missingState = imp.missing.some((m) => /^(statut|interventionState)$/i.test(m.trim()));
  const [state, setState] = useState<'' | 'realisee' | 'en_cours'>(missingState && !imp.reviewed ? '' : report.interventionState || (missingState ? '' : 'en_cours'));
  const [context, setContext] = useState(init.context);
  const [findings, setFindings] = useState(init.findings);
  const [workDone, setWorkDone] = useState(init.workDone);
  const [conclusion, setConclusion] = useState((report.conclusion || []).join('\n'));
  const [photos, setPhotos] = useState<PhotoState[]>(init.photos);
  const [groupOrder, setGroupOrder] = useState<string[]>(() => [...new Set(init.photos.map((p) => p.groupTitle))]);
  const [ackMissing, setAckMissing] = useState(imp.reviewed);
  const [ackWarnings, setAckWarnings] = useState(imp.reviewed);
  const [manual, setManual] = useState(imp.reviewed);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [reviewedSaved, setReviewedSaved] = useState(imp.reviewed);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [retryAck, setRetryAck] = useState(false);
  const [genMsg, setGenMsg] = useState('');
  const [sourcePage, setSourcePage] = useState(1);
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); setReviewedSaved(false); };

  const groups = groupOrder.map((title) => ({ title, items: photos.filter((p) => p.groupTitle === title) }));
  const siteList = (sites.data || []).filter((s) => s.active || s.id === report.siteId);

  const problems: string[] = [];
  if (!siteId) problems.push('site');
  if (!dates.length || dates.some((d) => !d)) problems.push('date');
  if (!state) problems.push('statut de l’intervention');
  if (bad(object)) problems.push('objet');
  if (bad(context)) problems.push('contexte');
  if (!lines(findings).length || MARKER.test(findings)) problems.push('constats');
  if (!lines(workDone).length || MARKER.test(workDone)) problems.push('intervention réalisée');
  if (!lines(conclusion).length || MARKER.test(conclusion)) problems.push('conclusion');
  if (MARKER.test(tenant)) problems.push('occupant');
  if (photos.some((p) => !p.deleted && (bad(p.groupTitle) || MARKER.test(p.caption)))) problems.push('titres de groupes de photos');
  const needMissing = imp.missing.length > 0 && !ackMissing;
  const needWarn = imp.warnings.length > 0 && !ackWarnings;
  const canValidate = !!siteId && !!state && !needMissing && !needWarn && manual;

  const payload = (reviewed: boolean) => {
    const ordered = groups.flatMap((g) => g.items);
    return {
      siteId, dates: dates.filter(Boolean), object: object.trim(), tenant: tenant.trim() || null, interventionState: state as 'realisee' | 'en_cours', context: context.trim(),
      findings: lines(findings), workDone: lines(workDone), conclusion: lines(conclusion), reviewed,
      photos: ordered.map((p, i) => ({ id: p.id, groupTitle: p.groupTitle.trim() || 'Intervention', order: i + 1, caption: p.caption.trim() || null, deleted: p.deleted })),
    };
  };
  const doSave = (reviewed: boolean) => {
    setMsg(''); setErr('');
    if (!state) { setErr('Choisissez le statut de l’intervention avant d’enregistrer.'); return; }
    save.mutate({ reportId, data: payload(reviewed) }, {
      onSuccess: (res) => {
        setDirty(false); setReviewedSaved(res.reviewed);
        setPhotos((current) => current.filter((photo) => !photo.deleted));
        queryClient.setQueryData(getGetPdfImportQueryKey(reportId), res);
        queryClient.invalidateQueries({ queryKey: getGetReportQueryKey(reportId) });
        queryClient.invalidateQueries({ queryKey: getListReportsQueryKey() });
        setMsg(reviewed ? 'Relecture validée. Vous pouvez générer le rapport.' : 'Brouillon de relecture enregistré.');
      },
      onError: (f) => setErr(requestFailure(f, 'L’enregistrement a échoué. Votre saisie est conservée ; réessayez.')),
    });
  };
  const doGenerate = () => {
    setGenMsg('');
    generate.mutate({ reportId }, {
      onSuccess: () => { void queryClient.invalidateQueries({ queryKey: getListReportVersionsQueryKey(reportId) }); setGenMsg('Nouvelle version générée.'); },
      onError: (f) => setGenMsg(requestFailure(f, 'La génération du rapport a échoué.')),
    });
  };
  const doRetry = () => retry.mutate({ reportId }, {
    onSuccess: (res) => { queryClient.setQueryData(getGetPdfImportQueryKey(reportId), res); void queryClient.invalidateQueries({ queryKey: getGetPdfImportQueryKey(reportId) }); },
  });

  /* group & photo ops */
  const renameGroup = (from: string, to: string) => {
    if (to !== from && groupOrder.includes(to)) return;
    setGroupOrder(groupOrder.map((g) => (g === from ? to : g)));
    setPhotos(photos.map((p) => (p.groupTitle === from ? { ...p, groupTitle: to } : p)));
    setDirty(true); setReviewedSaved(false);
  };
  const moveGroup = (i: number, d: number) => {
    const j = i + d; if (j < 0 || j >= groupOrder.length) return;
    const next = [...groupOrder]; [next[i], next[j]] = [next[j], next[i]]; touch(setGroupOrder)(next);
  };
  const movePhotoToGroup = (id: string, title: string) => touch(setPhotos)(photos.map((p) => (p.id === id ? { ...p, groupTitle: title } : p)));
  const movePhoto = (id: string, d: number) => {
    const p = photos.find((x) => x.id === id); if (!p) return;
    const same = photos.filter((x) => x.groupTitle === p.groupTitle);
    const k = same.findIndex((x) => x.id === id), other = same[k + d]; if (!other) return;
    const next = [...photos]; const a = next.findIndex((x) => x.id === id), b = next.findIndex((x) => x.id === other.id);
    [next[a], next[b]] = [next[b], next[a]]; touch(setPhotos)(next);
  };
  const setDeleted = (ids: string[], deleted: boolean) => touch(setPhotos)(photos.map((p) => (ids.includes(p.id) ? { ...p, deleted } : p)));
  const addGroup = () => {
    let n = groupOrder.length + 1, t = `Nouveau groupe ${n}`; while (groupOrder.includes(t)) t = `Nouveau groupe ${++n}`;
    touch(setGroupOrder)([...groupOrder, t]);
  };

  return <div data-testid="import-review">
    {!failed && <div className="imp-notice" style={{ background: '#edf7f1', border: '1px solid #c9e3d4', color: '#24745a' }} data-testid="import-ready">
      <strong>Analyse terminée — la fiche est préremplie.</strong>
      <p style={{ margin: '6px 0 10px' }}>Vérifiez les informations et les points signalés, puis validez la relecture avant de générer le rapport.</p>
      <a className="btn btn-plain" href="#import-generation">Aller à la génération du rapport</a>
    </div>}
    {failed && <div className="imp-notice" style={{ background: '#fbe9ec', border: '1px solid #efc3cb', color: '#842d3d' }} data-testid="import-failed">
      <strong style={{ display: 'flex', gap: 7, alignItems: 'center' }}><AlertTriangle size={15} /> La lecture automatique a échoué</strong>
      <p style={{ margin: '6px 0 0' }}>{imp.error || 'Aucun détail n’a été fourni par le service.'}</p>
      <p style={{ margin: '6px 0 0' }}>Le PDF d’origine reste consultable. Vous pouvez compléter le dossier manuellement ci-dessous, ou relancer l’analyse.</p>
      {!confirmRetry ? <button className="btn btn-plain" style={{ marginTop: 10 }} onClick={() => setConfirmRetry(true)} data-testid="button-retry-import"><RotateCcw size={15} /> Relancer l’analyse</button>
        : <div style={{ marginTop: 10, padding: 12, background: '#fff', borderRadius: 10 }}>
          <strong>Attention : les valeurs actuellement saisies seront remplacées par celles de l’IA.</strong>
          <label className="imp-check"><input type="checkbox" checked={retryAck} onChange={(e) => setRetryAck(e.target.checked)} data-testid="check-retry-ack" /> Je comprends que mes corrections seront perdues.</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}><button className="btn btn-primary" disabled={!retryAck || retry.isPending} onClick={doRetry} data-testid="button-confirm-retry">{retry.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <RotateCcw size={15} />} Relancer et remplacer</button><button className="btn btn-plain" onClick={() => { setConfirmRetry(false); setRetryAck(false); }}>Annuler</button></div>
          {retry.isError && <p style={{ color: '#a23c4b', marginTop: 8 }}>{requestFailure(retry.error, 'La relance a échoué.')}</p>}
        </div>}
    </div>}

    <div className="imp-split">
      <section className="panel imp-source">
        <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid #f0e8ea' }}><strong style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}><FileText size={15} /> PDF d’origine</strong><a className="btn btn-plain" style={{ minHeight: 34, padding: '6px 11px' }} href={imp.sourceUrl} target="_blank" rel="noreferrer" data-testid="link-source-pdf"><ExternalLink size={14} /> Ouvrir</a></div>
        <div style={{ maxHeight: '78vh', overflow: 'auto', background: '#f3f3f3' }}>
          <img src={`${imp.previewUrl}/${sourcePage}`} alt={`PDF d’origine, page ${sourcePage}`} style={{ display: 'block', width: '100%' }} data-testid="image-source-pdf" />
        </div>
        <div className="row" style={{ padding: 12, justifyContent: 'space-between' }}>
          <button className="btn btn-plain" disabled={sourcePage === 1} onClick={() => setSourcePage((p) => p - 1)}>Précédente</button>
          <span style={{ fontSize: 12 }}>Page {sourcePage} / {imp.pageCount || 1}</span>
          <button className="btn btn-plain" disabled={sourcePage >= (imp.pageCount || 1)} onClick={() => setSourcePage((p) => p + 1)}>Suivante</button>
        </div>
      </section>

      <div>
        {(imp.missing.length > 0 || imp.warnings.length > 0) && <div className="imp-notice" style={{ background: '#fff5e6', border: '1px solid #f1d7aa', color: '#805323' }} data-testid="import-alerts">
          {imp.missing.length > 0 && <><strong>Éléments manquants ou douteux</strong><ul style={{ margin: '6px 0 8px', paddingLeft: 18 }}>{imp.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>
            <label className="imp-check"><input type="checkbox" checked={ackMissing} onChange={(e) => { setAckMissing(e.target.checked); setReviewedSaved(false); }} data-testid="check-ack-missing" /> J’ai pris connaissance de ces éléments. Les informations indisponibles peuvent rester non renseignées dans le rapport.</label></>}
          {imp.warnings.length > 0 && <><strong style={{ display: 'block', marginTop: imp.missing.length ? 12 : 0 }}>Points à vérifier</strong><ul style={{ margin: '6px 0 8px', paddingLeft: 18 }}>{imp.warnings.map((m, i) => <li key={i}>{m}</li>)}</ul>
            <label className="imp-check"><input type="checkbox" checked={ackWarnings} onChange={(e) => { setAckWarnings(e.target.checked); setReviewedSaved(false); }} data-testid="check-ack-warnings" /> J’ai vérifié ces points par rapport au PDF d’origine.</label></>}
        </div>}

        <div className="panel panel-pad" style={{ marginBottom: 14 }}>
          <h2 className="section-title" style={{ marginBottom: 14 }}>1. Informations générales</h2>
          <div className="form-grid">
            <Fld label="Site" bad={!siteId} wide={false}><select value={siteId} onChange={(e) => touch(setSiteId)(e.target.value)} data-testid="select-review-site">{siteList.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.clientName}</option>)}{!siteList.some((s) => s.id === siteId) && <option value={siteId}>{report.siteName}</option>}</select></Fld>
            <Fld label="2. Statut de l’intervention" bad={!state} wide={false}><select value={state} onChange={(e) => touch(setState)(e.target.value as '' | 'realisee' | 'en_cours')} data-testid="select-review-state">{!state && <option value="">[À COMPLÉTER]</option>}<option value="en_cours">En cours</option><option value="realisee">Intervention réalisée</option></select></Fld>
            <Fld label={dates.length > 1 ? 'Dates d’intervention' : 'Date d’intervention'} bad={dates.some((d) => !d)}>
              {dates.map((d, i) => <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}><input type="date" value={d} onChange={(e) => touch(setDates)(dates.map((x, k) => (k === i ? e.target.value : x)))} data-testid={`input-date-${i}`} />{dates.length > 1 && <button type="button" className="btn btn-plain" aria-label="Retirer cette date" onClick={() => touch(setDates)(dates.filter((_, k) => k !== i))}><X size={14} /></button>}</div>)}
              <button type="button" className="btn btn-plain" style={{ alignSelf: 'flex-start' }} onClick={() => touch(setDates)([...dates, ''])} data-testid="button-add-date"><Plus size={14} /> Ajouter une date</button>
            </Fld>
            <Fld label="Objet" bad={bad(object)}><input value={object} onChange={(e) => touch(setObject)(e.target.value)} data-testid="input-review-object" /></Fld>
            <Fld label="Occupant / locataire · facultatif" bad={MARKER.test(tenant)}><input value={tenant} onChange={(e) => touch(setTenant)(e.target.value)} /></Fld>
          </div>
        </div>

        <div className="panel panel-pad" style={{ marginBottom: 14 }}>
          <h2 className="section-title" style={{ marginBottom: 14 }}>3. Description de l’intervention</h2>
          <div className="form-grid">
            <Fld label="Contexte" bad={bad(context)}><textarea value={context} onChange={(e) => touch(setContext)(e.target.value)} data-testid="input-review-context" /></Fld>
            <Fld label="Constats effectués sur place — un par ligne" bad={!lines(findings).length || MARKER.test(findings)}><textarea value={findings} onChange={(e) => touch(setFindings)(e.target.value)} data-testid="input-review-findings" /></Fld>
            <Fld label="Intervention réalisée — une action par ligne" bad={!lines(workDone).length || MARKER.test(workDone)}><textarea value={workDone} onChange={(e) => touch(setWorkDone)(e.target.value)} data-testid="input-review-workdone" /></Fld>
          </div>
        </div>

        <div className="panel panel-pad" style={{ marginBottom: 14 }}>
          <h2 className="section-title" style={{ marginBottom: 14 }}>4. Conclusion</h2>
          <Fld label="Un point par ligne" bad={!lines(conclusion).length || MARKER.test(conclusion)}><textarea value={conclusion} onChange={(e) => touch(setConclusion)(e.target.value)} data-testid="input-review-conclusion" /></Fld>
        </div>

        <div className="panel panel-pad" style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: 12 }}><h2 className="section-title">5. Reportage photographique</h2><button className="btn btn-plain" onClick={addGroup} data-testid="button-add-group"><Plus size={14} /> Groupe</button></div>
          {!groups.length && <p style={{ fontSize: 12, color: '#817b98' }}>Aucune photo extraite de ce PDF.</p>}
          {groups.map((g, gi) => {
            const allGone = g.items.length > 0 && g.items.every((p) => p.deleted);
            return <div className="imp-group" key={gi} data-testid={`group-${gi}`}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div className={`field ${bad(g.title) ? 'imp-bad' : ''}`} style={{ flex: '1 1 200px' }}><label>Titre du groupe {bad(g.title) && <span className="imp-tag">[À COMPLÉTER]</span>}</label><GroupTitleInput value={g.title} onCommit={(v) => renameGroup(g.title, v)} testid={`input-group-title-${gi}`} /></div>
                <button className="btn btn-plain" aria-label="Monter le groupe" disabled={gi === 0} onClick={() => moveGroup(gi, -1)}><ArrowUp size={14} /></button>
                <button className="btn btn-plain" aria-label="Descendre le groupe" disabled={gi === groups.length - 1} onClick={() => moveGroup(gi, 1)}><ArrowDown size={14} /></button>
                {g.items.length > 0 ? <button className="btn btn-plain" onClick={() => setDeleted(g.items.map((p) => p.id), !allGone)} data-testid={`button-delete-group-${gi}`}>{allGone ? <><Undo2 size={14} /> Rétablir</> : <><Trash2 size={14} /> Supprimer</>}</button>
                  : <button className="btn btn-plain" onClick={() => touch(setGroupOrder)(groupOrder.filter((t) => t !== g.title))}><Trash2 size={14} /> Retirer</button>}
              </div>
              <div className="imp-photos">
                {g.items.map((p, pi) => <div key={p.id} className={`imp-photo ${p.deleted ? 'gone' : ''}`} data-testid={`photo-${p.id}`}>
                  <img src={p.url} alt={p.caption || `Photo ${pi + 1}`} loading="lazy" />
                  <input value={p.caption} placeholder="Légende" disabled={p.deleted} onChange={(e) => touch(setPhotos)(photos.map((x) => (x.id === p.id ? { ...x, caption: e.target.value } : x)))} />
                  <select value={p.groupTitle} disabled={p.deleted} aria-label="Déplacer vers le groupe" onChange={(e) => movePhotoToGroup(p.id, e.target.value)}>{groupOrder.map((t) => <option key={t} value={t}>{t || 'Sans titre'}</option>)}</select>
                  <div style={{ display: 'flex', gap: 5 }}>
                    <button className="btn btn-plain" style={{ minHeight: 30, padding: '4px 8px', flex: 1 }} aria-label="Photo précédente" disabled={pi === 0 || p.deleted} onClick={() => movePhoto(p.id, -1)}><ArrowUp size={13} /></button>
                    <button className="btn btn-plain" style={{ minHeight: 30, padding: '4px 8px', flex: 1 }} aria-label="Photo suivante" disabled={pi === g.items.length - 1 || p.deleted} onClick={() => movePhoto(p.id, 1)}><ArrowDown size={13} /></button>
                    <button className="btn btn-plain" style={{ minHeight: 30, padding: '4px 8px', flex: 1 }} aria-label={p.deleted ? 'Annuler la suppression' : 'Supprimer la photo'} onClick={() => setDeleted([p.id], !p.deleted)} data-testid={`button-delete-photo-${p.id}`}>{p.deleted ? <Undo2 size={13} /> : <Trash2 size={13} />}</button>
                  </div>
                </div>)}
              </div>
            </div>;
          })}
          <small style={{ color: '#817b98' }}>Les suppressions ne sont définitives qu’à l’enregistrement ; utilisez le bouton d’annulation avant.</small>
        </div>

        <div id="import-generation" className="panel panel-pad" style={{ marginBottom: 14, scrollMarginTop: 90 }}>
          <h2 className="section-title">Contrôle et génération</h2>
          {problems.length > 0 && <p style={{ fontSize: 12, color: '#805323', margin: '10px 0 0' }} data-testid="text-blocking">Informations à vérifier : {problems.join(', ')}. Les informations manquantes n’empêchent pas la génération ; aucun contenu ne sera inventé.</p>}
          <label className="imp-check"><input type="checkbox" checked={manual} onChange={(e) => { setManual(e.target.checked); setReviewedSaved(false); }} data-testid="check-manual-review" /> J’ai relu l’ensemble du dossier face au PDF d’origine.</label>
          {err && <p role="alert" style={{ color: '#a23c4b', fontSize: 12, marginTop: 12 }}>{err}</p>}
          {msg && <p style={{ color: '#24745a', fontSize: 12, marginTop: 12 }} data-testid="text-save-msg">{msg}</p>}
          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginTop: 16 }}>
            <button className="btn btn-plain" disabled={save.isPending || !dirty} onClick={() => doSave(false)} data-testid="button-save-draft">{save.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <Save size={15} />} Enregistrer le brouillon</button>
            <button className="btn btn-primary" disabled={save.isPending || !canValidate} onClick={() => doSave(true)} data-testid="button-validate-review"><Save size={15} /> Enregistrer et valider la relecture</button>
            <button className="btn btn-accent" disabled={generate.isPending || !reviewedSaved || dirty || !imp.reviewed && !reviewedSaved} onClick={doGenerate} data-testid="button-generate-report">{generate.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <FileText size={15} />} Générer le rapport MSB-BAT</button>
          </div>
          {(!reviewedSaved || dirty) && <p style={{ fontSize: 11, color: '#817b98', marginTop: 8 }}>La génération est disponible une fois la relecture validée et enregistrée.</p>}
          {genMsg && <p style={{ fontSize: 12, marginTop: 12, color: generate.isError ? '#a23c4b' : '#24745a' }} data-testid="text-generate-msg">{genMsg}</p>}
          {versions.isError ? <ErrorNotice retry={() => versions.refetch()} error={versions.error} /> : versions.data?.length ? <div style={{ marginTop: 14 }}>
            {[...versions.data].sort((a, b) => b.version - a.version).map((v) => <div key={v.id} className="list-row"><div style={{ minWidth: 0 }}><strong style={{ fontSize: 13 }}>Version {v.version} · {v.fileName}</strong><div style={{ fontSize: 11, color: v.compliant ? '#817b98' : '#a23c4b', marginTop: 5 }}>{new Date(v.createdAt).toLocaleString('fr-FR')} · {v.compliant ? 'Conforme' : `${v.issues.length} point(s) à revoir : ${v.issues.join(' ; ')}`}</div></div>
              {v.compliant && <a className="btn btn-soft" href={v.downloadUrl} target="_blank" rel="noreferrer" data-testid={`link-download-${v.version}`}><Download size={14} /> Télécharger</a>}</div>)}
          </div> : null}
        </div>
      </div>
    </div>
  </div>;
}

function GroupTitleInput({ value, onCommit, testid }: { value: string; onCommit: (v: string) => void; testid: string }) {
  const [v, setV] = useState(value);
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { last.current = value; setV(value); } }, [value]);
  return <input value={v} placeholder="Titre du groupe" data-testid={testid} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) { last.current = v; onCommit(v); } }} />;
}

/* ---------- Erased names ---------- */
export function ErasedNamesPage() {
  const user = useGetCurrentUser();
  const allowed = user.data?.role === 'administratif' || user.data?.role === 'direction';
  const names = useListErasedNames({ query: { queryKey: getListErasedNamesQueryKey(), enabled: allowed } });
  const add = useAddErasedName();
  const del = useDeleteErasedName();
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  if (user.isLoading) return <AppShell><Loading count={2} /></AppShell>;
  if (user.isError) return <AppShell><ErrorNotice error={user.error} retry={() => user.refetch()} /></AppShell>;
  if (!allowed) return <Forbidden text="La liste des noms à effacer est réservée à l’administration et à la direction." />;
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListErasedNamesQueryKey() });
  const submit = (e: FormEvent) => {
    e.preventDefault(); setErr('');
    const value = name.trim(); if (!value) return;
    add.mutate({ data: { name: value } }, { onSuccess: () => { setName(''); void refresh(); }, onError: (f) => setErr(requestFailure(f, 'Ce nom n’a pas pu être ajouté.')) });
  };
  return <AppShell>
    <PageHead eyebrow="Confidentialité des imports" title="Noms à effacer" description="Ces noms et leurs variantes sont retirés du texte de chaque PDF importé avant tout traitement, et recherchés dans le PDF final." />
    <div className="panel panel-pad" style={{ maxWidth: 700 }}>
      <form onSubmit={submit} style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: '1 1 240px' }}><label htmlFor="erased-name">Ajouter un nom ou une variante</label><input id="erased-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. SRP" data-testid="input-erased-name" /></div>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-end' }} type="submit" disabled={add.isPending || !name.trim()} data-testid="button-add-erased-name">{add.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <Plus size={15} />} Ajouter</button>
      </form>
      {err && <p role="alert" style={{ color: '#a23c4b', fontSize: 12, marginTop: 10 }}>{err}</p>}
      <div style={{ marginTop: 18 }}>
        {names.isLoading ? <Loading count={2} /> : names.isError ? <ErrorNotice error={names.error} retry={() => names.refetch()} /> : names.data?.length ? names.data.map((n) => <div key={n.id} className="list-row" data-testid={`row-erased-${n.id}`}><strong style={{ fontSize: 13 }}>{n.name}</strong>
          <button className="btn btn-plain" disabled={pending === n.id} aria-label={`Supprimer ${n.name}`} onClick={() => { if (!window.confirm(`Retirer « ${n.name} » de la liste ?`)) return; setPending(n.id); del.mutate({ nameId: n.id }, { onSuccess: () => { setPending(null); void refresh(); }, onError: (f) => { setPending(null); setErr(requestFailure(f, 'Suppression impossible.')); } }); }} data-testid={`button-delete-erased-${n.id}`}><Trash2 size={14} /> Retirer</button></div>)
          : <div className="empty"><div className="empty-mark"><Eraser size={19} /></div><strong>Aucun nom à effacer</strong><p style={{ fontSize: 13 }}>Ajoutez le nom d’un sous-traitant pour qu’il disparaisse des rapports importés.</p></div>}
      </div>
    </div>
  </AppShell>;
}
