import { useState, useEffect, useRef } from 'react';
import {
  Terminal, Filter, RefreshCw, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, Search, X
} from 'lucide-react';
import { getSystemLogs } from '../api/client';

const LEVEL_COLORS = {
  fatal: 'bg-red-600 text-white',
  error: 'bg-red-500/20 text-red-400',
  warn: 'bg-yellow-500/20 text-yellow-400',
  info: 'bg-blue-500/20 text-blue-400',
  debug: 'bg-gray-500/20 text-gray-400',
};

const SOURCE_COLORS = {
  backend: 'bg-purple-500/20 text-purple-400',
  frontend: 'bg-green-500/20 text-green-400',
  extension: 'bg-orange-500/20 text-orange-400',
};

export default function SystemLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const refreshRef = useRef(null);

  const [filters, setFilters] = useState({
    level: '',
    source: '',
    component: '',
    request_id: '',
    search: '',
  });
  const [pagination, setPagination] = useState({
    offset: 0,
    limit: 25,
    hasMore: true,
  });

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = {
        ...filters,
        limit: pagination.limit,
        offset: pagination.offset,
      };
      const data = await getSystemLogs(params);
      setLogs(data.data || []);
      setPagination((prev) => ({
        ...prev,
        hasMore: (data.data || []).length === prev.limit,
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [filters, pagination.offset]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      refreshRef.current = setInterval(fetchLogs, 10_000);
    }
    return () => {
      if (refreshRef.current) clearInterval(refreshRef.current);
    };
  }, [autoRefresh, filters, pagination.offset]);

  const handleFilterChange = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPagination((prev) => ({ ...prev, offset: 0 }));
  };

  const traceByRequestId = (requestId) => {
    setFilters((prev) => ({ ...prev, request_id: requestId }));
    setPagination((prev) => ({ ...prev, offset: 0 }));
  };

  const clearFilters = () => {
    setFilters({ level: '', source: '', component: '', request_id: '', search: '' });
    setPagination((prev) => ({ ...prev, offset: 0 }));
  };

  const nextPage = () => setPagination((prev) => ({ ...prev, offset: prev.offset + prev.limit }));
  const prevPage = () => setPagination((prev) => ({ ...prev, offset: Math.max(0, prev.offset - prev.limit) }));

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    return d.toLocaleString();
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Terminal className="w-6 h-6" />
            System Logs
          </h1>
          <p className="text-[#818384] mt-1">Unified logs from backend, frontend, and extension</p>
        </div>
        <div className="flex gap-2 items-center">
          <label className="flex items-center gap-2 text-sm text-[#818384] cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh
          </label>
          <button
            onClick={fetchLogs}
            className="flex items-center gap-2 px-4 py-2 bg-[#272729] text-white rounded-lg hover:bg-[#343536] transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg p-4 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="w-4 h-4 text-[#818384]" />
          <span className="text-sm font-medium text-white">Filters</span>
          {filters.request_id && (
            <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full">
              Tracing: {filters.request_id}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <select
            value={filters.level}
            onChange={(e) => handleFilterChange('level', e.target.value)}
            className="bg-[#272729] border border-[#343536] text-white rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All Levels</option>
            <option value="fatal">Fatal</option>
            <option value="error">Error</option>
            <option value="warn">Warning</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>

          <select
            value={filters.source}
            onChange={(e) => handleFilterChange('source', e.target.value)}
            className="bg-[#272729] border border-[#343536] text-white rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All Sources</option>
            <option value="backend">Backend</option>
            <option value="frontend">Frontend</option>
            <option value="extension">Extension</option>
          </select>

          <input
            type="text"
            value={filters.component}
            onChange={(e) => handleFilterChange('component', e.target.value)}
            placeholder="Component..."
            className="bg-[#272729] border border-[#343536] text-white rounded-lg px-3 py-2 text-sm"
          />

          <input
            type="text"
            value={filters.request_id}
            onChange={(e) => handleFilterChange('request_id', e.target.value)}
            placeholder="Request ID..."
            className="bg-[#272729] border border-[#343536] text-white rounded-lg px-3 py-2 text-sm"
          />

          <div className="relative">
            <Search className="w-4 h-4 text-[#818384] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
              placeholder="Search message..."
              className="bg-[#272729] border border-[#343536] text-white rounded-lg pl-9 pr-3 py-2 text-sm w-full"
            />
          </div>

          <button
            onClick={clearFilters}
            className="flex items-center justify-center gap-1 px-3 py-2 text-sm text-[#818384] hover:text-white transition-colors"
          >
            <X className="w-3 h-3" />
            Clear
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg p-4 mb-6">
          {error}
        </div>
      )}

      {/* Logs Table */}
      <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg overflow-hidden">
        {loading && logs.length === 0 ? (
          <div className="p-8 text-center">
            <div className="animate-spin h-8 w-8 border-2 border-[#ff4500] border-t-transparent rounded-full mx-auto" />
            <p className="mt-4 text-[#818384]">Loading logs...</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center">
            <Terminal className="w-12 h-12 text-[#343536] mx-auto mb-4" />
            <p className="text-[#818384]">No log entries found</p>
          </div>
        ) : (
          <div className="divide-y divide-[#343536]">
            {/* Header row */}
            <div className="grid grid-cols-[140px_80px_90px_1fr_100px] gap-2 px-4 py-3 text-sm font-medium text-[#818384]">
              <span>Time</span>
              <span>Level</span>
              <span>Source</span>
              <span>Message</span>
              <span></span>
            </div>

            {logs.map((log) => (
              <div key={log.id}>
                <div
                  className="grid grid-cols-[140px_80px_90px_1fr_100px] gap-2 px-4 py-3 hover:bg-[#272729] transition-colors cursor-pointer items-center"
                  onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                >
                  <span className="text-xs text-[#818384] font-mono">
                    {formatDate(log.created_at)}
                  </span>
                  <span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LEVEL_COLORS[log.level] || 'text-[#818384]'}`}>
                      {log.level}
                    </span>
                  </span>
                  <span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${SOURCE_COLORS[log.source] || 'text-[#818384]'}`}>
                      {log.source}
                    </span>
                  </span>
                  <span className="text-sm text-[#d7dadc] truncate">
                    {log.component && (
                      <span className="text-[#818384] mr-1">[{log.component}]</span>
                    )}
                    {log.message}
                  </span>
                  <span className="flex items-center gap-1 justify-end">
                    {log.request_id && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          traceByRequestId(log.request_id);
                        }}
                        className="text-xs text-blue-400 hover:text-blue-300 px-1"
                        title={`Trace ${log.request_id}`}
                      >
                        Trace
                      </button>
                    )}
                    {expandedId === log.id ? (
                      <ChevronUp className="w-4 h-4 text-[#818384]" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-[#818384]" />
                    )}
                  </span>
                </div>

                {/* Expanded detail */}
                {expandedId === log.id && (
                  <div className="px-4 py-3 bg-[#0a0a0b] border-t border-[#343536]">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs mb-3">
                      {log.request_id && (
                        <div>
                          <span className="text-[#818384]">Request ID: </span>
                          <span className="text-blue-400 font-mono">{log.request_id}</span>
                        </div>
                      )}
                      {log.component && (
                        <div>
                          <span className="text-[#818384]">Component: </span>
                          <span className="text-[#d7dadc]">{log.component}</span>
                        </div>
                      )}
                      {log.error_name && (
                        <div>
                          <span className="text-[#818384]">Error: </span>
                          <span className="text-red-400">{log.error_name}</span>
                        </div>
                      )}
                      {log.url && (
                        <div>
                          <span className="text-[#818384]">URL: </span>
                          <span className="text-[#d7dadc] truncate">{log.url}</span>
                        </div>
                      )}
                    </div>
                    {log.error_stack && (
                      <div className="mb-3">
                        <p className="text-xs text-[#818384] mb-1">Stack Trace:</p>
                        <pre className="text-xs text-red-300/80 bg-[#1a1a1b] p-3 rounded-lg overflow-x-auto whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                          {log.error_stack}
                        </pre>
                      </div>
                    )}
                    {log.metadata && Object.keys(log.metadata).length > 0 && (
                      <div>
                        <p className="text-xs text-[#818384] mb-1">Metadata:</p>
                        <pre className="text-xs text-[#d7dadc] bg-[#1a1a1b] p-3 rounded-lg overflow-x-auto whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                          {JSON.stringify(log.metadata, null, 2)}
                        </pre>
                      </div>
                    )}
                    {log.browser_info && (
                      <p className="text-xs text-[#818384] mt-2 truncate">
                        Browser: {log.browser_info}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {logs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#343536]">
            <span className="text-sm text-[#818384]">
              Showing {pagination.offset + 1} - {pagination.offset + logs.length}
            </span>
            <div className="flex gap-2">
              <button
                onClick={prevPage}
                disabled={pagination.offset === 0}
                className="flex items-center gap-1 px-3 py-1 text-sm text-white bg-[#272729] rounded-lg hover:bg-[#343536] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </button>
              <button
                onClick={nextPage}
                disabled={!pagination.hasMore}
                className="flex items-center gap-1 px-3 py-1 text-sm text-white bg-[#272729] rounded-lg hover:bg-[#343536] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
