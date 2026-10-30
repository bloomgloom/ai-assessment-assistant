import { useEffect, useState } from 'react';
import { RECORDS_TREE_COLLAPSED_KEY } from './constants';
import { ClassItem, RecordsTreeNode } from './types';

function buildRecordsTree(classes: ClassItem[]): RecordsTreeNode[] {
  const result: RecordsTreeNode[] = [];
  const yMap = new Map<number, RecordsTreeNode>();

  for (const c of classes) {
    if (!yMap.has(c.year)) {
      const node: RecordsTreeNode = { kind: 'year', year: c.year, label: `${c.year}학년도`, children: [], path: `y${c.year}` };
      yMap.set(c.year, node);
      result.push(node);
    }
    const yNode = yMap.get(c.year)!;

    let sNode = yNode.children!.find(n => n.semester === c.semester);
    if (!sNode) {
      sNode = { kind: 'semester', year: c.year, semester: c.semester, label: `${c.semester}학기`, children: [], path: `y${c.year}s${c.semester}` };
      yNode.children!.push(sNode);
    }

    let gNode = sNode.children!.find(n => n.grade === c.grade);
    if (!gNode) {
      gNode = { kind: 'grade', year: c.year, semester: c.semester, grade: c.grade, label: `${c.grade}학년`, children: [], path: `y${c.year}s${c.semester}g${c.grade}` };
      sNode.children!.push(gNode);
    }

    let subNode = gNode.children!.find(n => n.subject === c.subject);
    if (!subNode) {
      subNode = { kind: 'subject', year: c.year, semester: c.semester, grade: c.grade, subject: c.subject, label: c.subject, children: [], path: `y${c.year}s${c.semester}g${c.grade}_${c.subject}` };
      gNode.children!.push(subNode);
    }

    let roomNode = subNode.children!.find(n => n.room === c.room);
    if (!roomNode) {
      roomNode = { kind: 'room', room: c.room, label: c.room, classItem: c, children: [] };
      subNode.children!.push(roomNode);
    }
  }
  return result;
}

export function useRecordsTree(classes: ClassItem[]) {
  const [tree, setTree] = useState<RecordsTreeNode[]>([]);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(RECORDS_TREE_COLLAPSED_KEY) === '1');
  const [openStates, setOpenStates] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setTree(buildRecordsTree(classes));
  }, [classes]);

  const getNodeOpen = (path: string) => path in openStates ? openStates[path] : true;
  const toggleNodeOpen = (path: string) =>
    setOpenStates(prev => ({ ...prev, [path]: !(path in prev ? prev[path] : true) }));

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(RECORDS_TREE_COLLAPSED_KEY, next ? '1' : '0');
  };

  return {
    tree,
    collapsed,
    openStates,
    getNodeOpen,
    toggleNodeOpen,
    toggleCollapsed,
  };
}
