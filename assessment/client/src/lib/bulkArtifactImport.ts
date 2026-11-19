export type BulkExistingPolicy = 'skip' | 'replace' | 'append';

export interface ExistingArtifactsConflict {
  conflict: 'existing_artifacts';
  message: string;
  total?: number;
  existingStudentCount?: number;
  existingTargetCount?: number;
  existingArtifactCount?: number;
  readyCount?: number;
  unmatchedCount?: number;
  conflictCount?: number;
  dateMissingCount?: number;
  results?: any[];
}

export function isExistingArtifactsConflict(value: any): value is ExistingArtifactsConflict {
  return value?.conflict === 'existing_artifacts';
}

export const bulkExistingPolicyActions: Array<{
  policy: BulkExistingPolicy;
  label: string;
  className: string;
}> = [
  { policy: 'skip', label: '기존 유지 · 건너뛰기', className: 'btn-secondary' },
  { policy: 'replace', label: '기존 삭제 · 새로 등록', className: 'btn-danger' },
  { policy: 'append', label: '기존과 새 파일 모두 등록', className: 'btn-primary' },
];
