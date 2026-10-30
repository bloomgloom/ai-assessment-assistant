import { ChangeEvent, ReactNode, RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { acceptToFilters, filesToInputChangeEvent, hasDesktopFileDialogs, openFiles } from '../../lib/desktopFiles';
import { Tooltip } from './Tooltip';

type PageHeaderActionVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'rainbow';

interface PageHeaderActionBase {
  key: string;
  label?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  loadingLabel?: ReactNode;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  variant?: PageHeaderActionVariant;
  className?: string;
}

export interface PageHeaderButtonAction extends PageHeaderActionBase {
  type?: 'button';
  onClick: () => void;
}

export interface PageHeaderFileAction extends PageHeaderActionBase {
  type: 'file';
  inputRef?: RefObject<HTMLInputElement>;
  accept?: string;
  multiple?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

export interface PageHeaderCustomAction extends PageHeaderActionBase {
  type: 'custom';
  render: () => ReactNode;
}

export type PageHeaderAction = PageHeaderButtonAction | PageHeaderFileAction | PageHeaderCustomAction;

function variantClassName(variant: PageHeaderActionVariant = 'secondary') {
  switch (variant) {
    case 'primary':
      return 'btn-primary';
    case 'success':
      return 'btn-success';
    case 'danger':
      return 'btn-secondary border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 hover:border-red-300';
    case 'rainbow':
      return 'btn-rainbow';
    case 'secondary':
    default:
      return 'btn-secondary';
  }
}

function actionClassName(action: PageHeaderAction) {
  const sizeClass = action.label || action.loadingLabel ? 'text-sm px-4' : 'p-2';
  return `${variantClassName(action.variant)} ${sizeClass} ${action.className || ''}`.trim();
}

function actionContent(action: PageHeaderAction) {
  if (action.loading) {
    return (
      <>
        <Loader2 size={14} className="animate-spin" />
        {action.loadingLabel || action.label}
      </>
    );
  }

  return (
    <>
      {action.icon}
      {action.label}
    </>
  );
}

export function PageHeaderActions({ actions }: { actions: PageHeaderAction[] }) {
  const useDesktopDialogs = hasDesktopFileDialogs();

  return (
    <div className="flex gap-2">
      {actions.map(action => {
        if (action.type === 'custom') {
          return <div key={action.key}>{action.render()}</div>;
        }

        if (action.type === 'file') {
          if (useDesktopDialogs) {
            return (
              <Tooltip key={action.key} content={action.title} align="end">
                <button
                  type="button"
                  className={actionClassName(action)}
                  onClick={async () => {
                    const files = await openFiles({
                      multiple: action.multiple,
                      filters: acceptToFilters(action.accept),
                    });
                    if (!files?.length) return;
                    action.onChange(filesToInputChangeEvent(files) as unknown as ChangeEvent<HTMLInputElement>);
                  }}
                  disabled={action.disabled || action.loading}
                  aria-label={action.ariaLabel || action.title}
                >
                  {actionContent(action)}
                </button>
              </Tooltip>
            );
          }

          return (
            <Tooltip key={action.key} content={action.title} align="end">
              <label
                className={`${actionClassName(action)} cursor-pointer ${action.disabled || action.loading ? 'opacity-60' : ''}`}
                aria-label={action.ariaLabel || action.title}
              >
                {actionContent(action)}
                <input
                  ref={action.inputRef}
                  type="file"
                  accept={action.accept}
                  multiple={action.multiple}
                  className="hidden"
                  onChange={action.onChange}
                  disabled={action.disabled || action.loading}
                />
              </label>
            </Tooltip>
          );
        }

        return (
          <Tooltip key={action.key} content={action.title} align="end">
            <button
              type="button"
              className={actionClassName(action)}
              onClick={action.onClick}
              disabled={action.disabled || action.loading}
              aria-label={action.ariaLabel || action.title}
            >
              {actionContent(action)}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
