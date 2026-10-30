export interface ActivityReflectionRecord {
  date: string;
  topic: string;
  plus: string;
  minus: string;
  interesting: string;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i += 1; } else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); if (row.some(value => value.length)) rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('되돌아보기 CSV의 따옴표가 닫히지 않았습니다.');
  row.push(field); if (row.some(value => value.length)) rows.push(row);
  return rows;
}

function reflectionDate(raw: string): string {
  const match = raw.trim().match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})$/);
  if (!match) return '';
  const month = Number(match[2]), day = Number(match[3]);
  const parsed = new Date(Date.UTC(Number(match[1]), month - 1, day));
  if (parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return '';
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

export function parseActivityReflectionCsv(buffer: Buffer): ActivityReflectionRecord[] {
  const rows = parseCsv(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  const headers = rows.shift()?.map(value => value.trim()) || [];
  const required = ['날짜', '학습주제', 'Plus', 'Minus', 'Interesting'];
  const column = (name: string) => headers.indexOf(name);
  if (required.some(name => column(name) < 0)) throw new Error('되돌아보기 CSV 머리글이 올바르지 않습니다.');
  return rows.map((row, index) => {
    const date = reflectionDate(row[column('날짜')] || '');
    if (!date) throw new Error(`되돌아보기 CSV ${index + 2}행의 날짜 형식이 올바르지 않습니다.`);
    return {
      date,
      topic: row[column('학습주제')] || '',
      plus: row[column('Plus')] || '',
      minus: row[column('Minus')] || '',
      interesting: row[column('Interesting')] || '',
    };
  });
}
