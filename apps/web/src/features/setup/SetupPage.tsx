import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getReadiness, PUBLIC_CONFIG_QUERY } from '../../shared/api-client.js';

const CONNECTION_STATES = {
  checking: { kind: 'checking', messageKey: 'connection.state.checking' },
  failed: { kind: 'failed', messageKey: 'connection.state.failed' },
  ready: { kind: 'ready', messageKey: 'connection.state.ready' },
  waiting: { kind: 'waiting', messageKey: 'connection.state.waiting' },
} as const;

/** Shows the bootstrap connection state without presenting unimplemented actions. */
export function SetupPage() {
  const { t } = useTranslation('setup');
  const config = useQuery(PUBLIC_CONFIG_QUERY);
  const readiness = useQuery({
    queryKey: ['readiness'],
    queryFn: ({ signal }) => getReadiness(signal),
    refetchInterval: 10_000,
  });
  // One derived state owns both the badge's wording and its visual treatment.
  const connection = getConnectionState({
    isReady: readiness.data?.status === 'ready',
    isPending: config.isPending || readiness.isPending,
    hasError: config.isError || readiness.isError,
  });

  return (
    <main id="main-content" className="setup-page">
      <p className="eyebrow">{t('breadcrumb')}</p>
      <h1>{t('title')}</h1>
      <p className="introduction">{t('description')}</p>
      <section className="connection-panel" aria-labelledby="connection-title">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">{t('connection.kicker')}</p>
            <h2 id="connection-title">{t('connection.title')}</h2>
          </div>
          <span
            className={connection.kind === 'ready' ? 'status status-ready' : 'status'}
            role="status"
          >
            {t(connection.messageKey)}
          </span>
        </div>
        <dl className="connection-list">
          <div>
            <dt>{t('connection.platform')}</dt>
            <dd>{t(config.isSuccess ? 'connection.connected' : 'connection.waiting')}</dd>
          </div>
          <div>
            <dt>{t('connection.history')}</dt>
            <dd>
              {t(
                readiness.data?.checks.database === 'up'
                  ? 'connection.ready'
                  : 'connection.waiting',
              )}
            </dd>
          </div>
          <div>
            <dt>{t('connection.scheduling')}</dt>
            <dd>
              {t(
                readiness.data?.checks.redis === 'up'
                  ? 'connection.available'
                  : 'connection.waiting',
              )}
            </dd>
          </div>
        </dl>
        <div className="panel-footer">
          <p>{t('connection.description')}</p>
          <button
            type="button"
            onClick={refreshConnection}
            disabled={config.isFetching || readiness.isFetching}
          >
            {t('connection.refresh')}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
        {connection.kind === 'failed' ? (
          <p className="error-message" role="alert">
            {t('connection.error')}
          </p>
        ) : null}
      </section>
      <p className="workspace-note">{t('workspaceNote')}</p>
    </main>
  );

  function refreshConnection() {
    // Query observers publish failures through isError; refetch resolves with that result.
    void Promise.all([
      config.refetch({ throwOnError: false }),
      readiness.refetch({ throwOnError: false }),
    ]);
  }
}

function getConnectionState({
  isPending,
  hasError,
  isReady,
}: {
  isPending: boolean;
  hasError: boolean;
  isReady: boolean;
}) {
  if (hasError) return CONNECTION_STATES.failed;
  if (isPending) return CONNECTION_STATES.checking;
  if (isReady) return CONNECTION_STATES.ready;

  return CONNECTION_STATES.waiting;
}
