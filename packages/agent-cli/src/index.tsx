/**
 * Reusable Ink-based chat UI shared by the agent kits.
 *
 * The problem it solves: the kits print log lines with `console.log` and prompt
 * with a fresh readline per question, so the input line scrolls away with the
 * logs. This module pins the input to the bottom of the terminal (like Claude
 * Code) while logs scroll above it, by rendering an Ink app: a `<Static>`
 * scrollback region (each line printed once into terminal history, so it scrolls
 * naturally) plus a live bottom region holding the input box.
 *
 * The kits keep their imperative turn loop untouched — they just call `log()`
 * and `await ask()` on the controller this returns instead of touching
 * `console.log`/readline directly.
 */
import { createInterface } from 'node:readline/promises';
import { format } from 'node:util';

import { Box, render, Static, Text, type Instance } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';

/** Imperative handle the kits drive; identical shape in TTY and non-TTY modes. */
export interface ChatUi {
  /** Append one line to the scrollback log (keeps any embedded ANSI color). */
  log(line: string): void;
  /** Pin `question` at the bottom and resolve with the line the user submits. */
  ask(question: string): Promise<string>;
  /** Show (or clear, with null) a transient status line above the input. */
  setStatus(text: string | null): void;
  /** Show (or clear, with null) a persistent balance line pinned above the input. */
  setBalance(text: string | null): void;
  /** Unmount the UI and restore the patched console methods. */
  close(): void;
}

export interface ChatUiOptions {
  /** Optional banner printed once at the top of the scrollback. */
  title?: string;
}

interface LogItem {
  id: number;
  text: string;
}

interface Snapshot {
  logs: LogItem[];
  question: string | null;
  status: string | null;
  balance: string | null;
}

interface Store {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Snapshot;
}

/**
 * Create the terminal chat UI. In a real TTY this renders the pinned-input Ink
 * app; when stdout/stdin is not a TTY (CI, piped, redirected) it falls back to
 * plain `console.log` + readline so scripted runs keep working unchanged.
 */
export function createChatUi(options: ChatUiOptions = {}): ChatUi {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return interactive ? createInkUi(options) : createPlainUi();
}

/** Strip a trailing prompt marker (`> `) and whitespace so the question reads as
 * a clean label above the input box; the box draws its own `>` caret. */
function toLabel(question: string): string {
  return question.replace(/[\s>]+$/, '');
}

function createInkUi(options: ChatUiOptions): ChatUi {
  const initialLogs: LogItem[] = options.title ? [{ id: 0, text: options.title }] : [];
  let snapshot: Snapshot = { logs: initialLogs, question: null, status: null, balance: null };
  let nextId = 1;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const store: Store = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };

  const pushLog = (text: string): void => {
    snapshot = { ...snapshot, logs: [...snapshot.logs, { id: nextId++, text }] };
    emit();
  };

  // One pending question at a time: the kits await ask() sequentially.
  let resolveAsk: ((value: string) => void) | null = null;
  const ask = (question: string): Promise<string> =>
    new Promise<string>((resolve) => {
      resolveAsk = resolve;
      snapshot = { ...snapshot, question };
      emit();
    });
  const submit = (value: string): void => {
    const resolve = resolveAsk;
    resolveAsk = null;
    snapshot = { ...snapshot, question: null };
    emit();
    resolve?.(value);
  };

  const setStatus = (text: string | null): void => {
    snapshot = { ...snapshot, status: text };
    emit();
  };

  const setBalance = (text: string | null): void => {
    snapshot = { ...snapshot, balance: text };
    emit();
  };

  // Route stray console output (tool logs, agent retries, CLI login output)
  // into the scrollback so nothing prints outside the Ink frame. Ink's own
  // console patching is disabled below so these two never fight.
  const original = { log: console.log, error: console.error, warn: console.warn };
  const capture =
    () =>
    (...args: unknown[]): void =>
      pushLog(format(...args));
  console.log = capture();
  console.error = capture();
  console.warn = capture();

  const instance: Instance = render(<App store={store} onSubmit={submit} />, {
    // We own console patching (above); let Ink render straight to stdout.
    patchConsole: false,
  });

  // Idempotent: kits may close on the exit path, in a catch, and again in a
  // finally, so guard against double unmount / double console restore.
  let closed = false;
  return {
    log: pushLog,
    ask,
    setStatus,
    setBalance,
    close: () => {
      if (closed) return;
      closed = true;
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
      instance.unmount();
    },
  };
}

function App({ store, onSubmit }: { store: Store; onSubmit: (value: string) => void }): ReactElement {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [value, setValue] = useState('');

  // Clear the buffer whenever a new question is posed so a stale answer never
  // carries over between prompts.
  useEffect(() => {
    if (snap.question !== null) setValue('');
  }, [snap.question]);

  const handleSubmit = (submitted: string): void => {
    setValue('');
    onSubmit(submitted);
  };

  return (
    <Box flexDirection="column">
      <Static items={snap.logs}>{(item) => <Text key={item.id}>{item.text}</Text>}</Static>
      {snap.status !== null ? <Text dimColor>{snap.status}</Text> : null}
      {snap.question !== null ? (
        <Box flexDirection="column" marginTop={1}>
          {toLabel(snap.question) ? <Text>{toLabel(snap.question)}</Text> : null}
          <Box borderStyle="round" paddingX={1}>
            <Text>{'> '}</Text>
            <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
          </Box>
        </Box>
      ) : null}
      {snap.balance !== null ? (
        <Text color="green">
          {'◈ '}
          <Text bold>Wallet Balance:</Text>
          {` ${snap.balance}`}
        </Text>
      ) : null}
    </Box>
  );
}

/** Non-TTY fallback: the pre-existing behavior (plain logs, per-prompt readline). */
function createPlainUi(): ChatUi {
  return {
    log: (line: string) => console.log(line),
    ask: async (question: string): Promise<string> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    setStatus: () => {},
    setBalance: () => {},
    close: () => {},
  };
}
