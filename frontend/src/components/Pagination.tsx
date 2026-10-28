interface PaginationProps {
  page: number;
  pages: number;
  total: number;
  limit: number;
  onChange: (page: number) => void;
}

export function Pagination({ page, pages, total, limit, onChange }: PaginationProps) {
  if (pages <= 1) {
    return (
      <div style={{ fontSize: 12, color: '#64748b', padding: '12px 0' }}>
        Showing {total} item{total === 1 ? '' : 's'}
      </div>
    );
  }

  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);

  // Build the visible page numbers with ellipses
  const visible: (number | '…')[] = [];
  const addPage = (n: number) => {
    if (!visible.includes(n)) visible.push(n);
  };

  addPage(1);
  if (page > 3) visible.push('…');
  for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) {
    addPage(i);
  }
  if (page < pages - 2) visible.push('…');
  if (pages > 1) addPage(pages);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 0',
      flexWrap: 'wrap',
      gap: 8,
    }}>
      <div style={{ fontSize: 12, color: '#64748b' }}>
        Showing {start}–{end} of {total}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button
          className="btn btn-sm"
          onClick={() => onChange(page - 1)}
          disabled={page === 1}
        >
          ‹ Prev
        </button>
        {visible.map((v, i) =>
          v === '…' ? (
            <span key={`ellipsis-${i}`} style={{ padding: '0 6px', color: '#64748b' }}>…</span>
          ) : (
            <button
              key={v}
              className={`btn btn-sm ${v === page ? 'btn-primary' : ''}`}
              onClick={() => onChange(v as number)}
              disabled={v === page}
            >
              {v}
            </button>
          )
        )}
        <button
          className="btn btn-sm"
          onClick={() => onChange(page + 1)}
          disabled={page === pages}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}