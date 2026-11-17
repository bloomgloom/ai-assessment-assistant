import { useState } from 'react';

function readStoredOpenStates(storageKey: string): Record<string, boolean> {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
  } catch {
    return {};
  }
}

export function usePersistentTreeOpenStates(storageKey: string) {
  const [openStates, setOpenStates] = useState<Record<string, boolean>>(() => readStoredOpenStates(storageKey));

  const getNodeOpen = (path: string) => path in openStates ? openStates[path] : true;
  const toggleNodeOpen = (path: string) => setOpenStates(prev => {
    const next = { ...prev, [path]: !(path in prev ? prev[path] : true) };
    localStorage.setItem(storageKey, JSON.stringify(next));
    return next;
  });

  return { openStates, getNodeOpen, toggleNodeOpen };
}
