// Zero-dependency CSV, Excel (SpreadsheetML .xls), and PDF report exporters
// with CSV/spreadsheet formula-injection neutralization and HTML escaping.

function neutralizeSpreadsheetFormula(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function escapeCsvCell(raw: unknown): string {
  const str = neutralizeSpreadsheetFormula(String(raw ?? ''));
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function escapeXml(raw: unknown): string {
  return neutralizeSpreadsheetFormula(String(raw ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function triggerDownload(blob: Blob, filename: string): void {
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export interface TabularSheet {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | boolean | null | undefined>>;
}

export function downloadCsv(sheet: TabularSheet, filename: string): void {
  const lines = [
    sheet.headers.map(escapeCsvCell).join(','),
    ...sheet.rows.map((r) => r.map(escapeCsvCell).join(',')),
  ];
  // Include UTF-8 BOM for proper Excel character rendering
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], {
    type: 'text/csv;charset=utf-8;',
  });
  triggerDownload(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

export function downloadExcelWorkbook(sheets: TabularSheet[], filename: string): void {
  const worksheetsXml = sheets
    .map((sheet) => {
      const safeTitle = escapeXml(sheet.name.slice(0, 31) || 'Sheet');
      const headerCells = sheet.headers
        .map((h) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`)
        .join('');
      const bodyRows = sheet.rows
        .map((row) => {
          const cells = row
            .map((cell) => {
              if (typeof cell === 'number' && Number.isFinite(cell)) {
                return `<Cell><Data ss:Type="Number">${cell}</Data></Cell>`;
              }
              return `<Cell><Data ss:Type="String">${escapeXml(cell ?? '')}</Data></Cell>`;
            })
            .join('');
          return `<Row>${cells}</Row>`;
        })
        .join('');

      return `<Worksheet ss:Name="${safeTitle}"><Table><Row>${headerCells}</Row>${bodyRows}</Table></Worksheet>`;
    })
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1F48D8" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 ${worksheetsXml}
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
  triggerDownload(blob, filename.endsWith('.xls') ? filename : `${filename}.xls`);
}

// Build a valid minimal single/multi-page PDF 1.4 document directly in-browser
// so automated & offline PDF downloads work cleanly without popup blockers!
export function buildPdfBytes(title: string, subtitle: string, sections: TabularSheet[]): Uint8Array {
  const lines: string[] = [];
  lines.push(title);
  lines.push(subtitle);
  lines.push('');

  for (const sec of sections) {
    lines.push(`=== ${sec.name.toUpperCase()} ===`);
    lines.push(sec.headers.join(' | '));
    lines.push('-'.repeat(Math.min(95, sec.headers.join(' | ').length)));
    if (sec.rows.length === 0) {
      lines.push('(No records)');
    } else {
      for (const r of sec.rows) {
        const line = r.map((v) => String(v ?? '—')).join(' | ');
        lines.push(line.slice(0, 108));
      }
    }
    lines.push('');
  }

  const linesPerPage = 46;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  if (pages.length === 0) pages.push([title]);

  const pdfSafe = (s: string) =>
    s
      .replace(/[^\x20-\x7E]/g, '?')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');

  // Object numbering:
  // 1 = Catalog, 2 = Pages, 3 = Font(Helvetica), 4.. = Page + ContentStream pairs
  const objects: string[] = [];
  const pageIds: number[] = [];

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let nextId = 4;
  for (const pageLines of pages) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);

    const ops: string[] = ['BT', '/F1 9 Tf', '40 752 Td', '15 TL'];
    pageLines.forEach((ln, idx) => {
      if (idx === 0) {
        ops.push(`(${pdfSafe(ln)}) Tj`);
      } else {
        ops.push(`T* (${pdfSafe(ln)}) Tj`);
      }
    });
    ops.push('ET');
    const streamBody = ops.join('\n');

    objects[contentId] = `<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
  }

  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new TextEncoder().encode(out);
}

export function downloadPdfReport(
  title: string,
  subtitle: string,
  sections: TabularSheet[],
  filename: string
): void {
  const bytes = buildPdfBytes(title, subtitle, sections);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  triggerDownload(blob, filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
}

export { escapeHtml, neutralizeSpreadsheetFormula };
