import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import {
  Settings, BookOpen, ClipboardList, ListChecks, Loader2, LogOut, Menu, CalendarDays
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import SettingsPage from './pages/SettingsPage';
import CriteriaPage from './pages/CriteriaPage';
import DomainPage from './pages/DomainPage';
import RecordsPage from './pages/RecordsPage';
import ActivityPage from './pages/ActivityPage';
import { AiGlobalOverlay } from './components/common/AiGlobalOverlay';
import { LessonJournalLinkDialogHost } from './components/common/LessonJournalLink';
import { useRecordsUnsavedStore } from './stores/recordsUnsavedStore';

const ArtifactStandalonePage = lazy(() =>
  import('./components/ArtifactViewer').then((module) => ({ default: module.ArtifactStandalonePage }))
);
const ArtifactPreviewStandalonePage = lazy(() =>
  import('./components/ArtifactPreviewModal').then((module) => ({ default: module.ArtifactPreviewStandalonePage }))
);

const SAVEABLE_PATHS = ['/criteria', '/domains', '/activity', '/records', '/settings'];

function LastLocationSaver() {
  const location = useLocation();
  useEffect(() => {
    if (SAVEABLE_PATHS.includes(location.pathname)) {
      localStorage.setItem('lastPath', location.pathname);
    }
  }, [location.pathname]);
  return null;
}

function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === '1');
  const hasUnsavedRecords = useRecordsUnsavedStore(state => state.hasUnsavedChanges);
  const location = useLocation();

  useEffect(() => {
    (window as any).__hasUnsavedChanges = hasUnsavedRecords;
  }, [hasUnsavedRecords]);
  const links = [
    { to: '/criteria', label: '성취 기준 관리', icon: BookOpen },
    { to: '/domains', label: '평가 영역 관리', icon: ListChecks },
    { to: '/activity', label: '활동 기록 관리', icon: CalendarDays },
    { to: '/records', label: '채점 기록 관리', icon: ClipboardList },
    { to: '/settings', label: '환경 설정', icon: Settings },
  ];

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sidebarCollapsed', next ? '1' : '0');
  };

  return (
    <aside className={`${collapsed ? 'w-16' : 'w-52'} h-screen overflow-y-auto bg-gray-900 text-gray-100 flex flex-col transition-[width] duration-200 shrink-0`}>
      <div className={`border-b border-gray-700 ${collapsed ? 'px-2 py-3' : 'px-3 py-4'}`}>
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2'}`}>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded text-gray-300 hover:bg-gray-800 hover:text-white"
            onClick={toggleCollapsed}
            title={collapsed ? '메뉴 펼치기' : '메뉴 접기'}
          >
            <Menu size={18} />
          </button>
          {!collapsed && (
            <div className="min-w-0">
              <h1 className="text-base font-bold leading-tight">평가 관리</h1>
            </div>
          )}
        </div>
      </div>
      <nav className="flex-1 py-3">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            title={collapsed ? label : undefined}
            onClick={(event) => {
              if (hasUnsavedRecords && location.pathname !== to && !confirm('저장되지 않은 변경 사항이 있습니다. 이동하시겠습니까?')) {
                event.preventDefault();
              }
            }}
            className={({ isActive }) =>
              `flex items-center ${collapsed ? 'justify-center px-2' : 'gap-2.5 px-4'} py-2.5 text-sm transition-colors ${isActive
                ? 'bg-blue-600 text-white'
                : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`
            }
          >
            <Icon size={16} />
            {!collapsed && label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-gray-800 py-3">
        <button
          type="button"
          title={collapsed ? '종료' : undefined}
          onClick={() => {
            if (hasUnsavedRecords && !confirm('저장되지 않은 변경 사항이 있습니다. 종료하시겠습니까?')) return;
            (window as any).__allowNextUnload = true;
            window.location.href = 'app://launcher';
          }}
          className={`flex w-full items-center ${collapsed ? 'justify-center px-2' : 'gap-2.5 px-4'} py-2.5 text-sm text-red-300 transition-colors hover:bg-red-950 hover:text-red-100`}
        >
          <LogOut size={16} />
          {!collapsed && '종료'}
        </button>
      </div>
    </aside>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden">
        <Routes>
          <Route path="/artifacts/:id/view" element={
            <Suspense fallback={<div className="h-screen flex items-center justify-center"><Loader2 className="animate-spin text-gray-400" /></div>}>
              <ArtifactStandalonePage />
            </Suspense>
          } />
          <Route path="/file-preview/:source/:id" element={
            <Suspense fallback={<div className="h-screen flex items-center justify-center"><Loader2 className="animate-spin text-gray-400" /></div>}>
              <ArtifactPreviewStandalonePage />
            </Suspense>
          } />
          <Route path="*" element={
            <>
              <LastLocationSaver />
              <Sidebar />
              <main className="flex min-h-0 min-w-0 flex-1 flex-col">
                <AiGlobalOverlay />
                <LessonJournalLinkDialogHost />
                <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                  <Routes>
                    <Route path="/" element={<Navigate to={localStorage.getItem('lastPath') || '/criteria'} replace />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/criteria" element={<CriteriaPage />} />
                    <Route path="/domains" element={<DomainPage />} />
                    <Route path="/lesson-plans" element={<Navigate to="/domains" replace />} />
                    <Route path="/activity" element={<ActivityPage />} />
                    <Route path="/records" element={<RecordsPage />} />
                  </Routes>
                </div>
              </main>
            </>
          } />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
