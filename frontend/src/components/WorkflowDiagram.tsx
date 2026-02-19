import React from 'react';

interface SourceMetadata {
  workflow_source?: string;
  workflow_class?: string;
  reward_fn_source?: string;
  reward_fn_name?: string;
  agent_source?: string;
  agent_class?: string;
}

interface Session {
  id: string;
  project: string;
  experiment: string;
  config: Record<string, any> | null;
  source_metadata?: SourceMetadata | null;
  created_at: string;
  completed_at: string | null;
}

interface WorkflowDiagramProps {
  session: Session | null;
}

const SourceCodePanel: React.FC<{
  title?: string;
  source?: string;
  fallbackMessage?: string;
}> = ({ title, source, fallbackMessage }) => (
  <div className="flex flex-col h-full">
    {title && (
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <h3 className="text-sm font-semibold text-gray-900 font-mono">{title}</h3>
      </div>
    )}
    <div className="flex-1 overflow-auto">
      {source ? (
        <pre className="p-4 text-xs font-mono text-black bg-white">
          <code>{source}</code>
        </pre>
      ) : fallbackMessage ? (
        <div className="p-4 text-sm text-gray-600">
          <p>Built-in function: <code className="bg-gray-100 px-2 py-1 rounded">{title}</code></p>
          <p className="mt-2 text-gray-500">{fallbackMessage}</p>
        </div>
      ) : null}
    </div>
  </div>
);

export const WorkflowDiagram: React.FC<WorkflowDiagramProps> = ({ session }) => {
  const metadata = session?.source_metadata;

  if (!metadata) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-gray-50">
        <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
          <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        </div>
        <p className="text-sm font-medium text-gray-900">No source code available</p>
      </div>
    );
  }

  const hasWorkflow = !!metadata.workflow_source;
  const hasReward = !!metadata.reward_fn_source || !!metadata.reward_fn_name;
  const hasAgent = !!metadata.agent_source;

  if (!hasWorkflow && !hasReward && !hasAgent) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-gray-50">
        <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
          <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        </div>
        <p className="text-sm font-medium text-gray-900">No source code available</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left Panel - Workflow Source */}
      {hasWorkflow && (
        <div
          className="bg-white flex flex-col overflow-hidden"
          style={{
            flex: 1,
            minWidth: 0,
            borderRight: (hasReward || hasAgent) ? '1px solid #e5e7eb' : undefined,
          }}
        >
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex-shrink-0">
            <span className="text-sm font-medium text-gray-900">Workflow</span>
            {metadata.workflow_class && (
              <span className="ml-2 text-xs text-gray-500 font-mono">{metadata.workflow_class}</span>
            )}
          </div>
          <div className="flex-1 overflow-auto">
            <pre className="p-4 text-xs font-mono text-black bg-white">
              <code>{metadata.workflow_source}</code>
            </pre>
          </div>
        </div>
      )}

      {/* Right Panel - Reward + Agent Source */}
      {(hasReward || hasAgent) && (
        <div
          className="bg-white flex flex-col overflow-hidden"
          style={{ flex: 1, minWidth: 0 }}
        >
          {/* Reward Function */}
          {hasReward && (
            <div className={`flex flex-col ${hasAgent ? '' : 'flex-1'}`} style={hasAgent ? { flex: 1, minHeight: 0 } : undefined}>
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex-shrink-0">
                <span className="text-sm font-medium text-gray-900">Reward Function</span>
                {metadata.reward_fn_name && (
                  <span className="ml-2 text-xs text-gray-500 font-mono">{metadata.reward_fn_name}</span>
                )}
              </div>
              <div className="flex-1 overflow-auto">
                <SourceCodePanel
                  source={metadata.reward_fn_source}
                  fallbackMessage={!metadata.reward_fn_source ? 'Source code not available for built-in functions.' : undefined}
                />
              </div>
            </div>
          )}

          {/* Agent Source - below reward if present */}
          {hasAgent && (
            <div className="flex flex-col" style={{ flex: 1, minHeight: 0, borderTop: hasReward ? '1px solid #e5e7eb' : undefined }}>
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex-shrink-0">
                <span className="text-sm font-medium text-gray-900">Agent</span>
                {metadata.agent_class && (
                  <span className="ml-2 text-xs text-gray-500 font-mono">{metadata.agent_class}</span>
                )}
              </div>
              <div className="flex-1 overflow-auto">
                <pre className="p-4 text-xs font-mono text-black bg-white">
                  <code>{metadata.agent_source}</code>
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
