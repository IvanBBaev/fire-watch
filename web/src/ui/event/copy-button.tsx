/** A copy button with a polite live line that reports the outcome. */

import { useState } from 'preact/hooks';

import { useApp } from '../context.js';
import { copyText } from './clipboard.js';

type CopyStatus = 'idle' | 'copied' | 'failed';

export function CopyButton({
  label,
  text,
}: {
  readonly label: string;
  readonly text: () => string;
}) {
  const { messages } = useApp();
  const [status, setStatus] = useState<CopyStatus>('idle');
  const onClick = (): void => {
    void copyText(text()).then((ok) => {
      setStatus(ok ? 'copied' : 'failed');
    });
  };
  return (
    <>
      <button type="button" class="button-secondary" onClick={onClick}>
        {label}
      </button>
      <span class="copy-status" role="status">
        {status === 'copied'
          ? messages.eventDetail.copied
          : status === 'failed'
            ? messages.eventDetail.copyFailed
            : ''}
      </span>
    </>
  );
}
