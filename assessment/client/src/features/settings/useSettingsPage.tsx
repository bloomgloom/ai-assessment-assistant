import { useState } from 'react';
import { Brain, ClipboardCheck, Database, Terminal } from 'lucide-react';
import { PageTab } from '../../components/common/PageTabs';
import { useSettingsController } from './useSettingsController';
import { SettingsTab } from './types';

export function useSettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('ai');
  const controller = useSettingsController();
  const tabs: PageTab<SettingsTab>[] = [
    { value: 'ai', label: 'AI', icon: <Brain size={14} />, color: 'blue' },
    { value: 'python', label: 'Python 환경', icon: <Terminal size={14} />, color: 'blue' },
    { value: 'assignment', label: '실시 관리', icon: <ClipboardCheck size={14} />, color: 'amber' },
    { value: 'data', label: '데이터', icon: <Database size={14} />, color: 'green' },
  ];

  return {
    header: { title: '환경 설정' },
    tabs: { value: activeTab, tabs, onChange: setActiveTab },
    contentProps: {
      activeTab,
      ...controller,
    },
  };
}
