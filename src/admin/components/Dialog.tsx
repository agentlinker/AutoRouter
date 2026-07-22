import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import type { ReactNode } from "react";

export type AppDialogTone = "success" | "error" | "info";

const toneIcon = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info
} as const;

export interface AppDialogProps {
  open: boolean;
  tone?: AppDialogTone;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  onClose: () => void;
}

export function AppDialog(props: AppDialogProps) {
  if (!props.open) {
    return null;
  }

  const tone = props.tone ?? "info";
  const Icon = toneIcon[tone];

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        className={`app-dialog ${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <span className="dialog-icon">
            <Icon size={20} />
          </span>
          <div>
            <h2 id="app-dialog-title">{props.title}</h2>
            {props.children ? <div className="dialog-body">{props.children}</div> : null}
          </div>
          <button className="icon-action" type="button" aria-label="关闭弹窗" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="dialog-actions">
          <button className="primary-action" type="button" onClick={props.onClose}>
            {props.confirmLabel ?? "知道了"}
          </button>
        </div>
      </section>
    </div>
  );
}
