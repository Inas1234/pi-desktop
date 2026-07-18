function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function scalar(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function tabularColumns(rows: Record<string, unknown>[]): string[] {
  const columns = new Set<string>();
  for (const row of rows.slice(0, 20)) {
    for (const [key, value] of Object.entries(row)) {
      if (isScalar(value)) columns.add(key);
      if (columns.size >= 6) break;
    }
  }
  return [...columns];
}

export function StructuredData({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (isScalar(value)) return <span className="structured-scalar">{scalar(value)}</span>;

  if (Array.isArray(value)) {
    const records = value.filter(isRecord);
    const columns = records.length === value.length ? tabularColumns(records) : [];
    if (value.length > 0 && columns.length > 0) {
      return (
        <div className="structured-table-wrap">
          <table className="structured-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
                <th>details</th>
              </tr>
            </thead>
            <tbody>
              {records.map((row, index) => {
                const nested = Object.fromEntries(
                  Object.entries(row).filter(
                    ([key, item]) => !columns.includes(key) || !isScalar(item),
                  ),
                );
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: bounded RPC arrays have no stable row identity.
                  <tr key={index}>
                    {columns.map((column) => (
                      <td key={column}>{scalar(row[column])}</td>
                    ))}
                    <td>
                      {Object.keys(nested).length > 0 ? (
                        <details className="structured-details">
                          <summary>show</summary>
                          <StructuredData value={nested} depth={depth + 1} />
                        </details>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }
    return (
      <ol className="structured-list">
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: bounded RPC arrays have no stable item identity.
          <li key={index}>
            <StructuredData value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }

  if (!isRecord(value)) return <span className="structured-scalar">{String(value)}</span>;
  return (
    <dl className="structured-object" data-depth={depth}>
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            {isScalar(item) ? (
              <StructuredData value={item} depth={depth + 1} />
            ) : (
              <details className="structured-details" open={depth === 0}>
                <summary>{Array.isArray(item) ? `${item.length} items` : "object"}</summary>
                <StructuredData value={item} depth={depth + 1} />
              </details>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
