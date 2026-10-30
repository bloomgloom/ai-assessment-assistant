export interface ActivityLessonPlanLike {
  lessonNo: number;
  progress: string;
}

export function nextActivityLessonNo(previousLessonNo?: number | null): number {
  const previous = Math.max(0, Math.trunc(Number(previousLessonNo) || 0));
  return previous + 1;
}

export function activityProgressForLesson(plans: ActivityLessonPlanLike[], lessonNo: number): string {
  return plans.find(plan => Number(plan.lessonNo) === Number(lessonNo))?.progress || '';
}

export function activityFilenameDecision(existingFilenames: Iterable<string>, candidate: string): 'add' | 'unchanged' {
  const normalized = candidate.normalize('NFC');
  return [...existingFilenames].some(filename => filename.normalize('NFC') === normalized) ? 'unchanged' : 'add';
}

export function appendActivityFilename(existingFilenames: string[], candidate: string): string[] {
  return activityFilenameDecision(existingFilenames, candidate) === 'unchanged'
    ? [...existingFilenames]
    : [...existingFilenames, candidate.normalize('NFC')];
}
