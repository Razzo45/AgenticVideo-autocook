"use client";

type ConformanceReport = {
  pass: boolean;
  checks: Array<{ id: string; label: string; pass: boolean; detail: string }>;
};

export function ConformanceTable({ report }: { report?: ConformanceReport | null }) {
  if (!report) return <p className="sub">No probe yet.</p>;
  return (
    <div>
      <p>
        Overall:{" "}
        <span className={`badge ${report.pass ? "pass" : "fail"}`}>{report.pass ? "pass" : "fail"}</span>
      </p>
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>Result</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {report.checks.map((c) => (
            <tr key={c.id}>
              <td>{c.label}</td>
              <td>
                <span className={`badge ${c.pass ? "pass" : "fail"}`}>{c.pass ? "pass" : "fail"}</span>
              </td>
              <td>{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
