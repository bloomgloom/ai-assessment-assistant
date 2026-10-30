export interface MatchableStudent {
  id: number;
  student_num: number;
  name: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 경로/파일명에서 학번 뒤에 이름이 나오는 학생을 찾는다. */
export function matchStudentsByPath<T extends MatchableStudent>(decodedPath: string, students: T[]): T[] {
  const normalizedPath = decodedPath.normalize('NFC');
  return [...students]
    .filter(student => student.name.length >= 2 && student.name.length <= 5)
    .sort((a, b) => b.name.length - a.name.length)
    .filter(student => {
      const numberPattern = new RegExp(`(?<![0-9])${student.student_num}(?![0-9])`, 'g');
      const namePattern = new RegExp(escapeRegExp(student.name.normalize('NFC')), 'g');
      const numberPositions = [...normalizedPath.matchAll(numberPattern)].map(match => match.index ?? -1);
      if (!numberPositions.length) return false;
      for (const nameMatch of normalizedPath.matchAll(namePattern)) {
        const nameIndex = nameMatch.index ?? -1;
        if (numberPositions.some(numberIndex => numberIndex >= 0 && numberIndex < nameIndex)) return true;
      }
      return false;
    });
}
