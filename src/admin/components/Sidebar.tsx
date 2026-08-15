import { Link } from "@tanstack/react-router";
import { Cpu, PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";

export interface SidebarNavItem {
  label: string;
  icon: LucideIcon;
  to: string;
}

export interface SidebarProps {
  items: readonly SidebarNavItem[];
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar(props: SidebarProps) {
  const toggleLabel = props.collapsed ? "展开侧边栏" : "收起侧边栏";
  const ToggleIcon = props.collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside className="sidebar">
      <div className="brand sidebar-brand">
        <div className="brand-mark">
          <Cpu size={21} />
        </div>
        <div className="sidebar-brand-text">
          <strong>AutoRouter</strong>
          <span>Control Plane</span>
        </div>
      </div>

      <nav className="side-nav" aria-label="Admin navigation">
        {props.items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.label}
              to={item.to}
              className="nav-item"
              activeProps={{ className: "nav-item active" }}
              // 收起态只剩图标，靠原生 tooltip 显示名称
              title={props.collapsed ? item.label : undefined}
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={toggleLabel}
          aria-expanded={!props.collapsed}
          title={toggleLabel}
          onClick={props.onToggle}
        >
          <ToggleIcon size={17} />
          <span>收起</span>
        </button>
      </div>
    </aside>
  );
}
