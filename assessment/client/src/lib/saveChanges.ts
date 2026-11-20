export const NO_SAVE_CHANGES_MESSAGE = '변경 사항이 없습니다.';

export function hasSaveChanges(hasChanges: boolean): boolean {
  if (hasChanges) return true;
  alert(NO_SAVE_CHANGES_MESSAGE);
  return false;
}
