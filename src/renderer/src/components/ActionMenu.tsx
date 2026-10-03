import { Fragment, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from './ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from './ui/context-menu';
export function ActionMenu({
  label,
  actions,
  children,
}: {
  label: string;
  actions: {
    label: string;
    run: () => void;
    disabled?: boolean;
    separator?: boolean;
    variant?: 'default' | 'destructive';
  }[];
  children?: ReactNode;
}) {
  // Detached trigger: dropdown and context menu must not become logical submenus.
  const [handle] = useState(() => Menu.createHandle());
  const menu = (
    <DropdownMenu handle={handle} modal={false}>
      <DropdownMenuContent aria-label={label} align="end">
        {actions.map((action) => (
          <Fragment key={action.label}>
            {action.separator && <DropdownMenuSeparator />}
            <DropdownMenuItem
              variant={action.variant}
              disabled={action.disabled}
              onClick={action.run}
            >
              {action.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={<div className={children ? 'object-actions' : 'tab-actions'} />}
        >
          {children}
          <DropdownMenuTrigger
            handle={handle}
            render={<Button variant="ghost" size="icon-sm" aria-label={label} title={label} />}
          >
            ⋯
          </DropdownMenuTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={label}>
          {actions.map((action) => (
            <Fragment key={action.label}>
              {action.separator && <ContextMenuSeparator />}
              <ContextMenuItem
                variant={action.variant}
                disabled={action.disabled}
                onClick={action.run}
              >
                {action.label}
              </ContextMenuItem>
            </Fragment>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      {menu}
    </>
  );
}
