/**
 * The WP6 admin/approval form for curated statements (TASKS L15; review 16 §5.10;
 * `docs/EDITORIAL-STANDARD.md`), at `/staff/curation`.
 *
 * Staff only, and never linked from the public chrome. The page is a lazy chunk (CI-12
 * lazy role `page`) so the public bundle does not carry it.
 *
 * The form checks the draft with the shared validator (`validateCuratedStatement` from
 * `@fire-watch/contracts`) before it sends, and names each broken rule; the server checks
 * again because the form is not trusted. Two-person approval is the server's rule: this
 * page only hides "approve" from someone who wrote the version, it does not enforce it.
 *
 * The page renders its form at once without probing the server: the staff routes are not
 * served anywhere yet (their host and cookie are an owner decision), and the first call
 * that finds them absent says so in one line.
 */

import {
  CURATED_STATEMENT_TYPES,
  CORRECTION_TEXT_MAX_LENGTH,
  EVENT_ID_MAX_LENGTH,
  JUSTIFICATION_MAX_LENGTH,
  SOURCE_REFERENCE_MAX_LENGTH,
  SOURCE_TIERS,
  TWO_SOURCE_EXCEPTIONS,
  validateCuratedStatement,
  type CuratedStatementDraft,
  type CuratedStatementType,
  type SourceTier,
  type StatementIssue,
  type TwoSourceException,
} from '@fire-watch/contracts';
import { useMemo, useState } from 'preact/hooks';

import type { Messages } from '../../core/i18n/messages.js';
import {
  createCurationClient,
  type CurationOutcome,
  type CurationRefusalKind,
  type StaffStatementVersion,
} from '../../core/staff/curation-client.js';
import { useApp } from '../context.js';

interface SourceFields {
  readonly tier: SourceTier;
  readonly url: string;
  readonly capture: string;
}

interface FormFields {
  readonly eventId: string;
  readonly statementType: CuratedStatementType;
  readonly source: SourceFields;
  readonly statedAt: string;
  readonly useSecondSource: boolean;
  readonly secondSource: SourceFields;
  readonly exception: TwoSourceException | 'none';
  readonly justification: string;
  readonly correctionText: string;
}

const EMPTY_SOURCE: SourceFields = { tier: 'T1', url: '', capture: '' };

const EMPTY_FORM: FormFields = {
  eventId: '',
  statementType: 'officially_contained',
  source: EMPTY_SOURCE,
  statedAt: '',
  useSecondSource: true,
  secondSource: { ...EMPTY_SOURCE, tier: 'T2' },
  exception: 'none',
  justification: '',
  correctionText: '',
};

/** The draft the form would send. Exported for the page test. */
export function draftOf(form: FormFields): CuratedStatementDraft {
  const isCorrection = form.statementType === 'curated_correction';
  return {
    eventId: form.eventId.trim(),
    statementType: form.statementType,
    source: { ...form.source, url: form.source.url.trim(), capture: form.source.capture.trim() },
    statedAt: form.statedAt.trim(),
    secondSource: form.useSecondSource
      ? {
          ...form.secondSource,
          url: form.secondSource.url.trim(),
          capture: form.secondSource.capture.trim(),
        }
      : null,
    exception: form.exception === 'none' ? null : form.exception,
    justification: form.justification.trim(),
    correctionText: isCorrection ? form.correctionText.trim() : null,
  };
}

function formOf(statement: CuratedStatementDraft): FormFields {
  return {
    eventId: statement.eventId,
    statementType: statement.statementType,
    source: statement.source,
    statedAt: statement.statedAt,
    useSecondSource: statement.secondSource !== null,
    secondSource: statement.secondSource ?? EMPTY_FORM.secondSource,
    exception: statement.exception ?? 'none',
    justification: statement.justification,
    correctionText: statement.correctionText ?? '',
  };
}

function refusalLine(messages: Messages, reason: CurationRefusalKind): string {
  const r = messages.staffCuration.refusal;
  switch (reason) {
    case 'not-signed-in':
      return r.notSignedIn;
    case 'forbidden':
      return r.forbidden;
    case 'invalid':
      return r.invalid;
    case 'source-unverified':
      return r.sourceUnverified;
    case 'capture-missing':
      return r.captureMissing;
    case 'not-found':
      return r.notFound;
    case 'wrong-status':
      return r.wrongStatus;
    case 'self-review':
      return r.selfReview;
    case 'conflict':
      return r.conflict;
  }
}

type Step = 'saved' | 'submitted' | 'reviewed' | 'opened';

function outcomeLine(messages: Messages, step: Step, outcome: CurationOutcome): string {
  const m = messages.staffCuration;
  switch (outcome.kind) {
    case 'unavailable':
      return m.unavailable;
    case 'failed':
      return m.outcome.failed;
    case 'refused':
      return refusalLine(messages, outcome.reason);
    case 'ok':
      if (step === 'opened') return '';
      if (step === 'submitted') return m.outcome.submitted;
      if (step === 'reviewed') {
        return outcome.value.status === 'published' ? m.outcome.published : m.outcome.returned;
      }
      return m.outcome.saved;
  }
}

function SourceFieldset({
  id,
  legend,
  value,
  onChange,
  messages,
}: {
  readonly id: string;
  readonly legend: string;
  readonly value: SourceFields;
  readonly onChange: (next: SourceFields) => void;
  readonly messages: Messages;
}) {
  const f = messages.staffCuration.fields;
  return (
    <fieldset>
      <legend>{legend}</legend>
      <label for={`${id}-tier`}>{f.tier}</label>
      <select
        id={`${id}-tier`}
        value={value.tier}
        onChange={(event) => {
          onChange({ ...value, tier: event.currentTarget.value as SourceTier });
        }}
      >
        {SOURCE_TIERS.map((tier) => (
          <option key={tier} value={tier}>
            {messages.staffCuration.tier[tier]}
          </option>
        ))}
      </select>
      <label for={`${id}-url`}>{f.url}</label>
      <input
        id={`${id}-url`}
        type="url"
        maxLength={SOURCE_REFERENCE_MAX_LENGTH}
        value={value.url}
        onInput={(event) => {
          onChange({ ...value, url: event.currentTarget.value });
        }}
      />
      <label for={`${id}-capture`}>{f.capture}</label>
      <input
        id={`${id}-capture`}
        type="text"
        maxLength={SOURCE_REFERENCE_MAX_LENGTH}
        value={value.capture}
        onInput={(event) => {
          onChange({ ...value, capture: event.currentTarget.value });
        }}
      />
    </fieldset>
  );
}

export function StaffCurationPage() {
  const { messages, serverNow } = useApp();
  const m = messages.staffCuration;
  const client = useMemo(
    () => createCurationClient({ fetchFn: (input, init) => fetch(input, init) }),
    [],
  );
  const [form, setForm] = useState<FormFields>(EMPTY_FORM);
  const [current, setCurrent] = useState<StaffStatementVersion | null>(null);
  /** A correction is being drafted against `current` (which is published). */
  const [correcting, setCorrecting] = useState(false);
  const [openId, setOpenId] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState('');
  const [issues, setIssues] = useState<readonly StatementIssue[]>([]);

  const set = (patch: Partial<FormFields>): void => {
    setForm((previous) => ({ ...previous, ...patch }));
  };

  const run = (step: Step, call: () => Promise<CurationOutcome>): void => {
    if (busy) return;
    setBusy(true);
    setLine('');
    void call().then((outcome) => {
      setBusy(false);
      setLine(outcomeLine(messages, step, outcome));
      if (outcome.kind !== 'ok') return;
      setCurrent(outcome.value);
      setCorrecting(false);
      setForm(formOf(outcome.value.statement));
      setIssues([]);
    });
  };

  const onSave = (event: Event): void => {
    event.preventDefault();
    const draft = draftOf(form);
    const found = validateCuratedStatement(draft, new Date(serverNow()));
    setIssues(found);
    if (found.length > 0) return;
    if (current === null) run('saved', () => client.create(draft));
    else if (correcting) run('saved', () => client.correct(current.entryId, draft));
    else run('saved', () => client.edit(current, draft));
  };

  const onOpen = (event: Event): void => {
    event.preventDefault();
    const id = openId.trim();
    if (id.length > 0) run('opened', () => client.read(id));
  };

  const onStartCorrection = (): void => {
    set({
      statementType: 'curated_correction',
      exception: 'own_correction',
      useSecondSource: false,
      correctionText: '',
    });
    setCorrecting(true);
    setLine('');
  };

  const onNew = (): void => {
    setCurrent(null);
    setCorrecting(false);
    setForm(EMPTY_FORM);
    setIssues([]);
    setLine('');
  };

  const status = current?.status ?? null;
  const editable = current === null || correcting || status !== 'published';
  const isCorrection = form.statementType === 'curated_correction';

  return (
    <article class="page staff-curation" data-ready="">
      <h1>{m.title}</h1>
      <p>{m.draftNotice}</p>
      <p>{m.intro}</p>

      <h2>{m.openTitle}</h2>
      <form class="auth-form" onSubmit={onOpen}>
        <label for="curation-open-id">{m.openLabel}</label>
        <input
          id="curation-open-id"
          type="text"
          value={openId}
          onInput={(event) => {
            setOpenId(event.currentTarget.value);
          }}
        />
        <button type="submit" class="button-secondary" disabled={busy}>
          {m.open}
        </button>
      </form>

      <h2>{m.formTitle}</h2>
      {current !== null ? (
        <dl class="staff-curation-meta">
          <dt>{m.versionLabel}</dt>
          <dd>{current.version}</dd>
          <dt>{m.statusLabel}</dt>
          <dd>{m.status[current.status]}</dd>
          {current.corrects !== null ? (
            <>
              <dt>{m.correctsLabel}</dt>
              <dd>{current.corrects}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {current?.youContributed === true && status === 'in_review' ? <p>{m.youWrote}</p> : null}

      <form class="auth-form" onSubmit={onSave}>
        <fieldset disabled={!editable || busy}>
          <label for="curation-event-id">{m.fields.eventId}</label>
          <input
            id="curation-event-id"
            type="text"
            maxLength={EVENT_ID_MAX_LENGTH}
            value={form.eventId}
            onInput={(event) => {
              set({ eventId: event.currentTarget.value });
            }}
          />
          <label for="curation-type">{m.fields.statementType}</label>
          <select
            id="curation-type"
            value={form.statementType}
            onChange={(event) => {
              set({ statementType: event.currentTarget.value as CuratedStatementType });
            }}
          >
            {CURATED_STATEMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {m.type[type]}
              </option>
            ))}
          </select>
          <SourceFieldset
            id="curation-source"
            legend={m.fields.sourceLegend}
            value={form.source}
            onChange={(source) => {
              set({ source });
            }}
            messages={messages}
          />
          <label for="curation-stated-at">{m.fields.statedAt}</label>
          <input
            id="curation-stated-at"
            type="text"
            value={form.statedAt}
            onInput={(event) => {
              set({ statedAt: event.currentTarget.value });
            }}
          />
          <label for="curation-second">
            <input
              id="curation-second"
              type="checkbox"
              checked={form.useSecondSource}
              onChange={(event) => {
                set({ useSecondSource: event.currentTarget.checked });
              }}
            />{' '}
            {m.fields.useSecondSource}
          </label>
          {form.useSecondSource ? (
            <SourceFieldset
              id="curation-second-source"
              legend={m.fields.secondSourceLegend}
              value={form.secondSource}
              onChange={(secondSource) => {
                set({ secondSource });
              }}
              messages={messages}
            />
          ) : null}
          <label for="curation-exception">{m.fields.exception}</label>
          <select
            id="curation-exception"
            value={form.exception}
            onChange={(event) => {
              set({ exception: event.currentTarget.value as FormFields['exception'] });
            }}
          >
            <option value="none">{m.exception.none}</option>
            {TWO_SOURCE_EXCEPTIONS.map((exception) => (
              <option key={exception} value={exception}>
                {m.exception[exception]}
              </option>
            ))}
          </select>
          <label for="curation-justification">{m.fields.justification}</label>
          <input
            id="curation-justification"
            type="text"
            maxLength={JUSTIFICATION_MAX_LENGTH}
            value={form.justification}
            onInput={(event) => {
              set({ justification: event.currentTarget.value });
            }}
          />
          {isCorrection ? (
            <>
              <label for="curation-correction">{m.fields.correctionText}</label>
              <textarea
                id="curation-correction"
                maxLength={CORRECTION_TEXT_MAX_LENGTH}
                value={form.correctionText}
                onInput={(event) => {
                  set({ correctionText: event.currentTarget.value });
                }}
              />
            </>
          ) : null}
          {issues.length > 0 ? (
            <div class="staff-curation-issues">
              <h3>{m.issuesTitle}</h3>
              <ul>
                {issues.map((issue) => (
                  <li key={issue}>{m.issue[issue]}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <button type="submit" class="button-primary">
            {busy ? m.working : m.actions.save}
          </button>
        </fieldset>
        <div class="staff-curation-actions">
          {current !== null && status === 'draft' && !correcting ? (
            <button
              type="button"
              class="button-secondary"
              disabled={busy}
              onClick={() => {
                run('submitted', () => client.submit(current.entryId));
              }}
            >
              {m.actions.submit}
            </button>
          ) : null}
          {current !== null && status === 'in_review' && !current.youContributed ? (
            <button
              type="button"
              class="button-secondary"
              disabled={busy}
              onClick={() => {
                run('reviewed', () => client.review(current, 'approve'));
              }}
            >
              {m.actions.approve}
            </button>
          ) : null}
          {current !== null && status === 'in_review' ? (
            <button
              type="button"
              class="button-secondary"
              disabled={busy}
              onClick={() => {
                run('reviewed', () => client.review(current, 'reject'));
              }}
            >
              {m.actions.reject}
            </button>
          ) : null}
          {current !== null && status === 'published' && !correcting ? (
            <button
              type="button"
              class="button-secondary"
              disabled={busy}
              onClick={onStartCorrection}
            >
              {m.actions.correct}
            </button>
          ) : null}
          {current !== null ? (
            <button type="button" class="button-secondary" disabled={busy} onClick={onNew}>
              {m.actions.newStatement}
            </button>
          ) : null}
        </div>
        <p class="auth-status" role="status">
          {line}
        </p>
      </form>
    </article>
  );
}
