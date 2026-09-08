import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export default function StudioModal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="studio-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`studio-modal ${wide ? 'studio-modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="studio-modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="studio-icon-button" aria-label="关闭弹窗" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="studio-modal-body">{children}</div>
      </section>
    </div>
  );
}
