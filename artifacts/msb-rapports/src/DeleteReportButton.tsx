import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { LoaderCircle, Trash2 } from 'lucide-react';
import {
  useDeleteReport, useGetCurrentUser, getGetReportQueryKey,
  getListReportsQueryKey, getGetDashboardSummaryQueryKey,
  getListReportVersionsQueryKey, getGetPdfImportQueryKey,
  type ReportSummary,
} from '@workspace/api-client-react';
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from './components/ui/alert-dialog';

type Props = { reportId: string; object: string; siteName: string; date: string };

export function DeleteReportButton({ reportId, object, siteName, date }: Props) {
  const { data: user } = useGetCurrentUser();
  const deletion = useDeleteReport();
  const client = useQueryClient();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  if (!user || !['direction', 'administratif', 'responsable_terrain'].includes(user.role)) return null;

  const remove = () => {
    setError('');
    deletion.mutate({ reportId }, {
      onSuccess: async (result) => {
        const keys = [
          getGetReportQueryKey(reportId), getListReportVersionsQueryKey(reportId),
          getGetPdfImportQueryKey(reportId),
        ];
        await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
        keys.forEach((queryKey) => client.removeQueries({ queryKey }));
        client.setQueriesData<ReportSummary[]>({ queryKey: getListReportsQueryKey() },
          (items) => items?.filter((item) => item.id !== reportId));
        void client.invalidateQueries({ queryKey: getListReportsQueryKey() });
        void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        setOpen(false);
        navigate(`/reports?deleted=1${result.cleanupPending ? '&cleanupPending=1' : ''}`);
      },
      onError: (failure) => {
        const detail = (failure as { data?: { detail?: unknown } })?.data?.detail;
        setError(typeof detail === 'string' ? detail : 'La suppression n’a pas pu être confirmée. Actualisez la liste des interventions avant de réessayer.');
      },
    });
  };

  return <AlertDialog open={open} onOpenChange={(next) => {
    if (deletion.isPending) return;
    setOpen(next); setError('');
  }}>
    <AlertDialogTrigger asChild>
      <button type="button" className="btn btn-soft" style={{ color: '#a23c4b' }} data-testid="button-delete-report">
        <Trash2 size={15} /> Supprimer le rapport
      </button>
    </AlertDialogTrigger>
    <AlertDialogContent style={{ width: 'calc(100% - 32px)', borderRadius: 16 }} data-testid="dialog-delete-report">
      <AlertDialogHeader>
        <AlertDialogTitle>Supprimer définitivement ce rapport ?</AlertDialogTitle>
        <AlertDialogDescription>
          <strong>{object || 'Intervention sans objet renseigné'}</strong><br />
          {siteName} · {new Date(date).toLocaleDateString('fr-FR')}<br /><br />
          Le dossier, ses zones, ses photos, les versions PDF, le PDF importé et l’historique seront supprimés.
          Cette action est irréversible. Le client et le site ne seront pas supprimés.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {error && <p role="alert" style={{ color: '#a23c4b', fontSize: 13 }}>{error}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={deletion.isPending} data-testid="button-cancel-delete-report">Annuler</AlertDialogCancel>
        <AlertDialogAction disabled={deletion.isPending} onClick={(event) => {
          event.preventDefault(); remove();
        }} style={{ background: '#a23c4b', color: 'white' }} data-testid="button-confirm-delete-report">
          {deletion.isPending && <LoaderCircle className="animate-spin" size={15} />}
          {deletion.isPending ? 'Suppression…' : 'Supprimer définitivement'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
