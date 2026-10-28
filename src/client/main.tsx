import '@vitejs/plugin-react/preamble';
import { useTheme, type Theme } from './theme';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Moon,
  Sun,
  Inbox,
  Send,
  FileText,
  Archive,
  ShieldAlert,
  Trash2,
  Star,
  Plus,
  Search,
  Mail,
  Settings,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
  Reply,
  ReplyAll,
  Forward,
  Paperclip,
  X,
  MoreHorizontal,
  Check,
  Menu,
  LogOut,
  RefreshCw,
  Tag,
  Download,
  Users,
  SlidersHorizontal,
  CheckCheck,
  Pause,
  Play,
  Copy,
  PenLine,
  Command,
} from 'lucide-react';
import type { MailAddress, MailMessage, Compose, Domain, Attachment } from '../shared/models';
import './style.css';
interface Bootstrap {
  user: string;
  local: boolean;
  addresses: MailAddress[];
  domains: Domain[];
  counts: Record<string, number>;
  labels: { id: string; name: string; color: string }[];
  contacts: { email: string; name: string }[];
  rules: {
    id: string;
    field: string;
    operator: string;
    value: string;
    action: string;
    action_value: string;
  }[];
  prefix: string;
  failedIntakes: number;
}
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Postbox-Request': '1',
      'X-Requested-With': 'XMLHttpRequest',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    let msg = 'Your session expired. Sign in again.';
    try {
      msg = ((await res.json()) as { error?: string }).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}
const folders = [
  ['inbox', 'Inbox', Inbox],
  ['starred', 'Starred', Star],
  ['sent', 'Sent', Send],
  ['draft', 'Drafts', FileText],
  ['archive', 'Archive', Archive],
  ['spam', 'Spam', ShieldAlert],
  ['trash', 'Trash', Trash2],
] as const;
const initials = (s: string) =>
  s
    .split(/[ @._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join('')
    .toUpperCase();
const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;
const date = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const split = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
function useDialogFocus() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement;
    const items = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled):not([type="hidden"]),textarea:not(:disabled),select:not(:disabled)',
        ),
      ).filter((e) => e.getClientRects().length);
    if (!root.contains(document.activeElement)) items()[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = items(),
        first = focusable[0],
        last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    const keep = (e: FocusEvent) => {
      if (!root.contains(e.target as Node)) items()[0]?.focus();
    };
    root.addEventListener('keydown', trap);
    document.addEventListener('focusin', keep);
    return () => {
      root.removeEventListener('keydown', trap);
      document.removeEventListener('focusin', keep);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return ref;
}
function App() {
  const { theme, dark, setTheme } = useTheme();
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [error, setError] = useState(''),
    [folder, setFolder] = useState('inbox'),
    [address, setAddress] = useState<string | null>(null),
    [q, setQ] = useState(''),
    [query, setQuery] = useState(''),
    [label, setLabel] = useState(''),
    [unread, setUnread] = useState(false),
    [messages, setMessages] = useState<MailMessage[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    [thread, setThread] = useState<MailMessage[]>([]),
    [checked, setChecked] = useState<string[]>([]),
    [loading, setLoading] = useState(false),
    [composer, setComposer] = useState<Compose | null>(null),
    [settings, setSettings] = useState<string | null>(null),
    [toast, setToast] = useState(''),
    [undo, setUndo] = useState<string | null>(null),
    [sidebar, setSidebar] = useState(false),
    [showHtml, setShowHtml] = useState(false),
    [refresh, setRefresh] = useState(0),
    [hasOlder, setHasOlder] = useState(false),
    [olderLoading, setOlderLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null),
    selectedRef = useRef(selected);
  selectedRef.current = selected;
  const notify = (s: string) => {
    setToast(s);
    setTimeout(() => setToast(''), 5000);
  };
  const reload = () => {
    setRefresh((x) => x + 1);
  };
  useEffect(() => {
    api<Bootstrap>('/bootstrap')
      .then(setBoot)
      .catch((e) => setError(e.message));
  }, [refresh]);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setOffset(0);
    setChecked([]);
  }, [folder, address, query, label, unread]);
  useEffect(() => {
    if (!boot) return;
    let active = true;
    setLoading(true);
    const search = new URLSearchParams({ folder, offset: String(offset) });
    if (address) search.set('address', address);
    if (query) search.set('q', query);
    if (label) search.set('label', label);
    if (unread) search.set('unread', '1');
    api<{ messages: MailMessage[]; total: number }>(`/messages?${search}`)
      .then((r) => {
        if (active) {
          setMessages(r.messages);
          setTotal(r.total);
        }
      })
      .catch((e) => notify(e.message))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [!!boot, folder, address, query, label, unread, offset, refresh]);
  useEffect(() => {
    if (!selected) {
      setThread([]);
      return;
    }
    let active = true;
    setShowHtml(false);
    api<{ messages: MailMessage[]; hasMore: boolean }>(`/messages/${selected}/thread`)
      .then((r) => {
        if (active) {
          setThread(r.messages);
          setHasOlder(r.hasMore);
        }
        return api(`/messages/${selected}`, 'PATCH', { is_read: true });
      })
      .then(() => {
        if (active) {
          setMessages((ms) => ms.map((m) => (m.id === selected ? { ...m, is_read: 1 } : m)));
          api<Bootstrap>('/bootstrap').then(setBoot);
        }
      })
      .catch((e) => notify(e.message));
    return () => {
      active = false;
    };
  }, [selected, refresh]);
  useEffect(() => {
    const t = setInterval(reload, 30000);
    return () => clearInterval(t);
  }, []);
  const newMail = () => {
    if (!boot?.addresses.some((a) => a.enabled && a.send_enabled)) {
      setSettings('addresses');
      notify('Add an address before composing');
      return;
    }
    const a =
      boot.addresses.find((a) => a.id === address && a.enabled && a.send_enabled) ||
      boot.addresses.find((a) => a.enabled && a.send_enabled)!;
    setComposer({
      id: crypto.randomUUID(),
      addressId: a.id,
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      text: a.signature ? '\n\n' + a.signature : '',
      attachments: [],
    });
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setSettings(null);
        setSelected(null);
      }
      if (
        e.key === 'c' &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName) &&
        !composer
      )
        newMail();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [boot, address, composer]);
  async function change(id: string, p: Record<string, unknown>) {
    try {
      await api(`/messages/${id}`, 'PATCH', p);
      reload();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function older() {
    const id = selected;
    if (!id || !thread.length) return;
    setOlderLoading(true);
    try {
      const page = await api<{ messages: MailMessage[]; hasMore: boolean }>(
        `/messages/${id}/thread?before=${thread[0].id}`,
      );
      if (selectedRef.current === id) {
        setThread((t) => [...page.messages, ...t]);
        setHasOlder(page.hasMore);
      }
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setOlderLoading(false);
    }
  }
  async function changeResolution(id: string, status: string, providerId = '') {
    try {
      await api(`/messages/${id}/resolve`, 'POST', { status, providerId });
      reload();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function bulk(p: Record<string, unknown>) {
    for (const id of checked) await change(id, p);
    setChecked([]);
  }
  async function openDraft(m: MailMessage) {
    try {
      const d = await api<MailMessage>(`/messages/${m.id}`);
      setComposer({
        id: d.id,
        revision: d.revision,
        addressId: d.address_id,
        to: JSON.parse(d.to_json),
        cc: JSON.parse(d.cc_json),
        bcc: JSON.parse(d.bcc_json),
        subject: d.subject,
        text: d.text || '',
        attachments: (d.attachments || []).map((a) => a.id),
        ...(d.reply_id ? { replyToMessageId: d.reply_id } : {}),
        ...(d.forward_id ? { forwardMessageId: d.forward_id } : {}),
      });
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function replyMail(m: MailMessage, mode: 'reply' | 'all' | 'forward') {
    const received = boot!.addresses.find((a) => a.id === m.address_id)!;
    const sender =
      received.enabled && received.send_enabled
        ? received
        : mode === 'forward'
          ? boot!.addresses.find((a) => a.enabled && a.send_enabled)
          : undefined;
    if (!sender) {
      notify('Sending is disabled for this receiving address. Enable it in Settings first.');
      return;
    }
    const mine = new Set(boot!.addresses.map((a) => a.email.toLowerCase()));
    const body =
      mode === 'forward'
        ? `\n\n---------- Forwarded message ----------\nFrom: ${m.from_name} <${m.from_address}>\nDate: ${date(m.received_at)}\nSubject: ${m.subject}\n\n${m.text || ''}`
        : `\n\nOn ${date(m.received_at)}, ${m.from_name || m.from_address} wrote:\n${(m.text || '')
            .split('\n')
            .map((l) => '> ' + l)
            .join('\n')}`;
    // The receiving identity remains the sender, even from the unified view.
    const to =
      mode === 'forward'
        ? []
        : m.direction === 'outbound'
          ? JSON.parse(m.to_json)
          : JSON.parse(m.reply_to_json || '[]').length
            ? JSON.parse(m.reply_to_json)
            : [m.from_address];
    const cc =
      mode === 'all'
        ? [...new Set([...JSON.parse(m.to_json), ...JSON.parse(m.cc_json)])].filter(
            (x) => !mine.has(x.toLowerCase()) && !to.includes(x),
          )
        : [];
    const a = sender;
    setComposer({
      id: crypto.randomUUID(),
      addressId: a.id,
      to,
      cc,
      bcc: [],
      subject: (mode === 'forward' ? 'Fwd: ' : 'Re: ') + m.subject.replace(/^(Re: |Fwd: )/i, ''),
      text: (a.signature ? '\n\n' + a.signature : '') + body,
      attachments: [],
      ...(mode !== 'forward' ? { replyToMessageId: m.id } : { forwardMessageId: m.id }),
    });
  }
  if (error && !boot)
    return (
      <div className="locked">
        <Mail size={36} />
        <h1>Your mailbox is protected</h1>
        <p>{error}</p>
        <button className="primary" onClick={() => location.reload()}>
          Try again
        </button>
        <p className="muted">Sign in through Cloudflare Access to continue.</p>
      </div>
    );
  if (!boot)
    return (
      <div className="locked">
        <Mail size={32} />
        <p>Opening your mailbox…</p>
      </div>
    );
  const current = boot.addresses.find((a) => a.id === address),
    title = label
      ? boot.labels.find((l) => l.id === label)?.name
      : folders.find((f) => f[0] === folder)?.[1] || 'All mail';
  const last = thread.at(-1);
  return (
    <div className="app">
      <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
        <button
          className="brand"
          onClick={() => {
            setFolder('inbox');
            setAddress(null);
            setSettings(null);
          }}
        >
          <span className="brand-icon">
            <Mail size={23} />
          </span>
          postbox<span className="brand-dot">●</span>
        </button>
        <p className="brand-caption">YOUR MAIL, YOUR SPACE</p>
        <button className="compose primary" onClick={newMail}>
          <PenLine size={17} /> Compose <span>C</span>
        </button>
        <nav aria-label="Folders">
          {folders.map(([id, name, Icon]) => (
            <button
              key={id}
              className={`nav-item ${folder === id && !label ? 'active' : ''}`}
              onClick={() => {
                setFolder(id);
                setLabel('');
                setSelected(null);
                setSidebar(false);
              }}
            >
              <Icon size={18} />
              <span>{name}</span>
              {boot.counts[id] ? <small>{boot.counts[id]}</small> : null}
            </button>
          ))}
        </nav>
        <div className="section-label">
          MAIL ADDRESSES
          <button
            title="Add address"
            aria-label="Add address"
            onClick={() => setSettings('addresses')}
          >
            <Plus size={15} />
          </button>
        </div>
        <button
          className={`address-item ${!address ? 'selected' : ''}`}
          onClick={() => {
            setAddress(null);
            setSelected(null);
            setSidebar(false);
          }}
        >
          <span className="all-dot">
            <Inbox size={14} />
          </span>
          <span>All inboxes</span>
        </button>
        {boot.addresses.map((a) => (
          <button
            key={a.id}
            className={`address-item ${address === a.id ? 'selected' : ''}`}
            onClick={() => {
              setAddress(a.id);
              setSelected(null);
              setSidebar(false);
            }}
          >
            <span className="color-dot" style={{ background: a.color }} />
            <span className="address-label">
              {a.name}
              <small>{a.email}</small>
            </span>
            {a.unread ? <small>{a.unread}</small> : null}
            {!a.enabled && <Pause size={12} />}
          </button>
        ))}
        <div className="section-label">
          LABELS
          <button title="Create label" onClick={() => setSettings('labels')}>
            <Plus size={15} />
          </button>
        </div>
        {boot.labels.map((l) => (
          <button
            className={`address-item ${label === l.id ? 'selected' : ''}`}
            key={l.id}
            onClick={() => {
              setLabel(l.id);
              setFolder('all');
              setSelected(null);
            }}
          >
            <span className="color-dot" style={{ background: l.color }} />
            {l.name}
          </button>
        ))}
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setSettings('addresses')}>
            <Settings size={17} /> Settings
          </button>
          <div className="profile">
            <span className="profile-avatar">{initials(boot.user)}</span>
            <div>
              <strong>Your workspace</strong>
              <small>{boot.user}</small>
            </div>
            <button
              aria-label="Log out"
              title="Log out"
              onClick={() => {
                setThread([]);
                setMessages([]);
                location.assign('/cdn-cgi/access/logout');
              }}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <button
            className="mobile-menu"
            aria-label="Open menu"
            onClick={() => setSidebar(!sidebar)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span> Mail
          </div>
          <div className="search">
            <Search size={17} />
            <input
              ref={searchRef}
              aria-label="Search mail"
              placeholder="Search your mail"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <kbd>⌘ K</kbd>
          </div>
          <button
            className="theme-toggle"
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={() => setTheme(dark ? 'light' : 'dark')}
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <span className="privacy">
            <span /> Private workspace
          </span>
        </header>
        {boot.failedIntakes > 0 && (
          <button className="local-banner" onClick={() => setSettings('health')}>
            {boot.failedIntakes} incoming message(s) need attention. Open mail processing.
          </button>
        )}
        {boot.local && (
          <div className="local-banner">
            Local preview{' '}
            <span>Sample mail · sending is simulated · production requires Cloudflare Access</span>
          </div>
        )}
        <div className={`mail-layout ${selected ? 'reading' : ''}`}>
          <section className="mail-list">
            <div className="list-heading">
              <div>
                <h1>{title}</h1>
                <p>{current ? current.email : 'All your addresses, together.'}</p>
              </div>
              <button aria-label="Refresh mail" title="Refresh mail" onClick={reload}>
                <RefreshCw size={17} />
              </button>
            </div>
            <div className="list-controls">
              <button
                className={`filter ${!unread ? 'chosen' : ''}`}
                onClick={() => setUnread(false)}
              >
                All mail <small>{total}</small>
              </button>
              <button
                className={`filter ${unread ? 'chosen' : ''}`}
                onClick={() => setUnread(true)}
              >
                Unread
              </button>
              <button className="list-view" onClick={() => setSettings('rules')} title="Mail rules">
                <SlidersHorizontal size={16} />
              </button>
            </div>
            {checked.length > 0 && (
              <div className="bulk-bar">
                <span>{checked.length} selected</span>
                <button title="Archive selected" onClick={() => bulk({ folder: 'archive' })}>
                  <Archive size={16} />
                </button>
                <button title="Mark read" onClick={() => bulk({ is_read: true })}>
                  <CheckCheck size={16} />
                </button>
                <button title="Trash selected" onClick={() => bulk({ folder: 'trash' })}>
                  <Trash2 size={16} />
                </button>
                <button onClick={() => setChecked([])} title="Clear selection">
                  <X size={15} />
                </button>
              </div>
            )}
            <div className="message-scroll">
              {loading && messages.length === 0 ? (
                <div className="empty">Loading mail…</div>
              ) : messages.length === 0 ? (
                <div className="empty">
                  <Inbox size={36} />
                  <h3>A little breathing room.</h3>
                  <p>{query ? 'No messages match your search.' : 'No messages here yet.'}</p>
                  {!boot.addresses.length && (
                    <button className="primary" onClick={() => setSettings('addresses')}>
                      Add your first address
                    </button>
                  )}
                </div>
              ) : (
                messages.map((m, i) => (
                  <article
                    key={m.id}
                    className={`message-row ${selected === m.id ? 'selected' : ''} ${!m.is_read ? 'unread' : ''}`}
                  >
                    <input
                      aria-label={`Select ${m.subject}`}
                      type="checkbox"
                      checked={checked.includes(m.id)}
                      onChange={(e) =>
                        setChecked((c) =>
                          e.target.checked ? [...c, m.id] : c.filter((id) => id !== m.id),
                        )
                      }
                    />
                    <button
                      className="message-main"
                      onClick={() => (folder === 'draft' ? openDraft(m) : setSelected(m.id))}
                    >
                      <span className={`avatar tone-${i % 5}`}>
                        {initials(m.from_name || m.from_address)}
                      </span>
                      <div className="message-copy">
                        <div className="message-meta">
                          <strong>{m.from_name || m.from_address}</strong>
                          <time>{date(m.received_at)}</time>
                        </div>
                        <h3>{m.subject || '(No subject)'}</h3>
                        <p>{m.snippet}</p>
                        <div className="message-tags">
                          <span style={{ color: m.address_color }}>
                            <span style={{ background: m.address_color }} />
                            {m.address_email}
                          </span>
                          {m.status === 'queued' && <em>Sending…</em>}
                          {m.status === 'unknown' && <em>Check delivery</em>}
                          {(m as MailMessage & { attachment_count: number }).attachment_count >
                            0 && <Paperclip size={12} />}
                        </div>
                      </div>
                    </button>
                    <button
                      className={`star-button ${m.starred ? 'starred' : ''}`}
                      title={m.starred ? 'Unstar' : 'Star'}
                      onClick={() => change(m.id, { starred: !m.starred })}
                    >
                      <Star size={15} fill={m.starred ? 'currentColor' : 'none'} />
                    </button>
                  </article>
                ))
              )}
            </div>
            <footer className="list-footer">
              <span>
                {total
                  ? `${offset + 1}–${Math.min(offset + 50, total)} of ${total}`
                  : 'You’re all caught up'}
              </span>
              <button
                aria-label="Previous page"
                disabled={!offset}
                onClick={() => setOffset((o) => Math.max(0, o - 50))}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                aria-label="Next page"
                disabled={offset + 50 >= total}
                onClick={() => setOffset((o) => o + 50)}
              >
                <ChevronRight size={15} />
              </button>
            </footer>
          </section>
          <section className="reader">
            {!last ? (
              <div className="reader-empty">
                <div className="envelope-art">
                  <Mail size={47} strokeWidth={1.2} />
                  <span className="spark one">✦</span>
                  <span className="spark two">✧</span>
                </div>
                <h2>Make room for what matters.</h2>
                <p>
                  Choose a message to read.
                  <br />
                  Your next conversation is waiting.
                </p>
                <div className="shortcut">
                  <Command size={13} /> K <span>to find something</span>
                </div>
              </div>
            ) : (
              <>
                <div className="reader-toolbar">
                  <button
                    className="back"
                    aria-label="Back to list"
                    onClick={() => setSelected(null)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <button title="Archive" onClick={() => change(selected!, { folder: 'archive' })}>
                    <Archive size={18} />
                  </button>
                  <button
                    title="Move to spam"
                    onClick={() => change(selected!, { folder: 'spam' })}
                  >
                    <ShieldAlert size={18} />
                  </button>
                  <button
                    title="Move to trash"
                    onClick={() => change(selected!, { folder: 'trash' })}
                  >
                    <Trash2 size={18} />
                  </button>
                  <span className="separator" />
                  <button title="Mark unread" onClick={() => change(selected!, { is_read: false })}>
                    <Mail size={18} />
                  </button>
                  <select
                    aria-label="Add label"
                    value=""
                    onChange={(e) =>
                      change(selected!, {
                        labels: [...new Set([...JSON.parse(last.labels_json), e.target.value])],
                      })
                    }
                  >
                    <option value="">Label…</option>
                    {boot.labels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <a title="Export message" href={`/api/messages/${selected}/export`}>
                    <Download size={18} />
                  </a>
                  {folder === 'trash' && (
                    <button
                      title="Delete permanently"
                      onClick={async () => {
                        if (confirm('Permanently delete this message and its attachments?')) {
                          try {
                            await api(`/messages/${selected}`, 'DELETE');
                            setSelected(null);
                            reload();
                          } catch (e) {
                            notify((e as Error).message);
                          }
                        }
                      }}
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                  {folder === 'trash' && (
                    <button
                      title="Restore"
                      onClick={async () => {
                        try {
                          await api(`/messages/${selected}/restore`, 'POST', {});
                          setSelected(null);
                          reload();
                        } catch (e) {
                          notify((e as Error).message);
                        }
                      }}
                    >
                      <Inbox size={18} />
                    </button>
                  )}
                  <button
                    className="toolbar-end"
                    title="Close message"
                    onClick={() => setSelected(null)}
                  >
                    <X size={17} />
                  </button>
                </div>
                <div className="reader-scroll">
                  <div className="subject-header">
                    <span className="eyebrow">CONVERSATION</span>
                    <h2>{last.subject}</h2>
                    <span className="received-pill" style={{ color: last.address_color }}>
                      <span style={{ background: last.address_color }} />
                      Received as {last.address_email}
                    </span>
                  </div>
                  {hasOlder && (
                    <button className="button" disabled={olderLoading} onClick={older}>
                      {olderLoading ? 'Loading…' : 'Load earlier messages'}
                    </button>
                  )}
                  {thread.map((m) => (
                    <div className="read-message" key={m.id}>
                      <div className="sender-row">
                        <span className="avatar tone-0">
                          {initials(m.from_name || m.from_address)}
                        </span>
                        <div>
                          <strong>{m.from_name || m.from_address}</strong>
                          <span>&lt;{m.from_address}&gt;</span>
                          <p>
                            to {JSON.parse(m.to_json).join(', ')}{' '}
                            {JSON.parse(m.cc_json).length > 0 &&
                              ` · cc ${JSON.parse(m.cc_json).join(', ')}`}
                          </p>
                        </div>
                        <time>
                          {new Date(m.received_at).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </time>
                      </div>
                      {m.truncated && (
                        <div className="warning">
                          Message preview is truncated.{' '}
                          <a href={`/api/messages/${m.id}/raw`}>Download the full original</a>.
                        </div>
                      )}
                      {m.error && <div className="warning">{m.error}</div>}
                      {m.direction === 'outbound' && (
                        <div className="delivery-note">
                          Delivery: {m.status}
                          {boot.local ? ' (local simulation)' : ''}
                          {m.delivery?.map((e) => (
                            <p key={e.recipient}>
                              {e.recipient}: {e.status}
                            </p>
                          ))}
                          {m.status === 'unknown' && (
                            <div>
                              <p>Check Email Sending logs before resolving this submission.</p>
                              <button
                                onClick={() => {
                                  if (
                                    confirm(
                                      'Have you confirmed provider acceptance? This records the result without sending again.',
                                    )
                                  )
                                    changeResolution(
                                      m.id,
                                      'accepted',
                                      prompt('Provider message ID (optional)') || '',
                                    );
                                }}
                              >
                                Record accepted
                              </button>
                              <button
                                onClick={() => {
                                  if (
                                    confirm(
                                      'Have you confirmed this message was not accepted? This records failure without sending again.',
                                    )
                                  )
                                    changeResolution(m.id, 'failed');
                                }}
                              >
                                Record failed
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      <div className="body-switch">
                        <button onClick={() => setShowHtml(!showHtml)}>
                          {showHtml ? 'Plain text' : 'Formatted view'}
                        </button>
                      </div>
                      {showHtml ? (
                        <SafeMessage message={m} dark={dark} />
                      ) : (
                        <div className="message-text">
                          {m.text ||
                            'This message contains only formatted content. Choose Formatted view to read it.'}
                        </div>
                      )}
                      {m.attachments?.length ? (
                        <div className="attachments">
                          {m.attachments.map((f) => (
                            <a key={f.id} href={`/api/attachments/${f.id}`}>
                              <span>
                                <FileText size={22} />
                              </span>
                              <div>
                                <strong>{f.filename}</strong>
                                <small>{bytes(f.size)}</small>
                              </div>
                              <Download size={15} />
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                  <div className="reply-actions">
                    <button onClick={() => replyMail(last, 'reply')}>
                      <Reply size={17} /> Reply
                    </button>
                    <button onClick={() => replyMail(last, 'all')}>
                      <ReplyAll size={17} /> Reply all
                    </button>
                    <button onClick={() => replyMail(last, 'forward')}>
                      <Forward size={17} /> Forward
                    </button>
                  </div>
                  <p className="reply-identity">
                    Your reply will be sent from <strong>{last.address_email}</strong>
                  </p>
                </div>
              </>
            )}
          </section>
        </div>
      </main>
      {settings && (
        <SettingsPanel
          tab={settings}
          setTab={setSettings}
          boot={boot}
          theme={theme}
          setTheme={setTheme}
          close={() => setSettings(null)}
          reload={reload}
          notify={notify}
        />
      )}
      {composer && (
        <Composer
          value={composer}
          boot={boot}
          close={() => {
            setComposer(null);
            reload();
          }}
          sent={(id) => {
            setComposer(null);
            setUndo(id);
            notify(boot.local ? 'Message queued for simulated delivery' : 'Message queued');
            setTimeout(() => setUndo(null), 10000);
            reload();
          }}
          notify={notify}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
          {undo && (
            <button
              onClick={async () => {
                try {
                  await api(`/messages/${undo}/undo`, 'POST', {});
                  setUndo(null);
                  notify('Send undone. Message saved in Drafts.');
                  reload();
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              Undo
            </button>
          )}
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
function SafeMessage({ message, dark }: { message: MailMessage; dark: boolean }) {
  const [html, setHtml] = useState(message.html || '');
  useEffect(() => {
    const urls: string[] = [];
    let active = true;
    (async () => {
      let s = message.html || '';
      for (const f of message.attachments || []) {
        if (!s.includes(`/api/attachments/${f.id}`)) continue;
        const r = await fetch(`/api/attachments/${f.id}`);
        if (r.ok) {
          const objectUrl = URL.createObjectURL(await r.blob());
          urls.push(objectUrl);
          s = s.replaceAll(`/api/attachments/${f.id}`, objectUrl);
        }
      }
      if (active) setHtml(s);
    })().catch(() => {});
    return () => {
      active = false;
      urls.forEach(URL.revokeObjectURL);
    };
  }, [message.id]);
  return (
    <iframe
      className="html-message"
      title="Formatted email (remote content blocked)"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>:root{color-scheme:${dark ? 'dark' : 'light'};background:${dark ? '#232323' : '#fff'}}body{background:${dark ? '#232323' : '#fff'};font:15px/1.8 system-ui;color:${dark ? '#dedde8' : '#35334a'};color-scheme:${dark ? 'dark' : 'light'};margin:0}a{color:${dark ? '#b6a5ff' : '#7566c7'}}img{max-width:100%}table{max-width:100%}</style>${html}`}
    />
  );
}
function Composer({
  value,
  boot,
  close,
  sent,
  notify,
}: {
  value: Compose;
  boot: Bootstrap;
  close: () => void;
  sent: (id: string) => void;
  notify: (s: string) => void;
}) {
  const dialogRef = useDialogFocus();
  const [draft, setDraft] = useState(value),
    [to, setTo] = useState(value.to.join(', ')),
    [cc, setCc] = useState(value.cc.join(', ')),
    [bcc, setBcc] = useState(value.bcc.join(', ')),
    [expanded, setExpanded] = useState(!!value.cc.length || !!value.bcc.length),
    [saving, setSaving] = useState('Draft'),
    [busy, setBusy] = useState(!!value.forwardMessageId && !value.attachments.length),
    [files, setFiles] = useState<{ id: string; filename: string; size: number }[]>([]);
  const upload = useRef<HTMLInputElement>(null),
    chain = useRef(Promise.resolve()),
    revision = useRef(value.revision || 0),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (value.attachments.length)
      api<MailMessage>(`/messages/${value.id}`)
        .then((m) =>
          setFiles(
            (m.attachments || []).map((f) => ({ id: f.id, filename: f.filename, size: f.size })),
          ),
        )
        .catch((e) => notify(e.message));
    else if (value.forwardMessageId)
      api<{ attachments: { id: string; filename: string; size: number }[] }>(
        '/attachments/copy',
        'POST',
        { messageId: value.forwardMessageId, addressId: value.addressId },
      )
        .then((r) => {
          setFiles(r.attachments);
          setDraft((d) => ({ ...d, attachments: r.attachments.map((f) => f.id) }));
        })
        .catch((e) => notify(e.message))
        .finally(() => setBusy(false));
  }, []);
  const snapshot = () => ({ ...draft, to: split(to), cc: split(cc), bcc: split(bcc) });
  async function save() {
    const p = snapshot();
    setSaving('Saving…');
    let result!: { id: string; revision: number };
    const task = chain.current.then(async () => {
      const saved = await api<{ id: string; revision: number }>('/drafts', 'POST', {
        ...p,
        revision: revision.current,
      });
      revision.current = saved.revision;
      result = saved;
      setSaving('Saved');
    });
    chain.current = task.catch(() => {});
    await task;
    return result;
  }
  useEffect(() => {
    if (!draft.subject && !draft.text.trim() && !to && !draft.attachments.length) return;
    if (busy) return;
    saveTimer.current = setTimeout(() => save().catch((e) => setSaving(e.message)), 1500);
    return () => clearTimeout(saveTimer.current);
  }, [draft, to, cc, bcc, busy]);
  const from = boot.addresses.find((a) => a.id === draft.addressId)!;
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="composer"
        role="dialog"
        aria-modal="true"
        aria-label="Compose message"
      >
        <header>
          <h2>{draft.replyToMessageId ? 'Reply' : 'New message'}</h2>
          <span>{saving}</span>
          <button
            title="Save and close"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              clearTimeout(saveTimer.current);
              try {
                await save();
                close();
              } catch (e) {
                notify((e as Error).message);
                setBusy(false);
              }
            }}
          >
            <X size={19} />
          </button>
        </header>
        <div className="compose-field">
          <label>From</label>
          <select
            aria-label="Sending address"
            value={draft.addressId}
            disabled={
              busy ||
              !!draft.replyToMessageId ||
              !!draft.forwardMessageId ||
              draft.attachments.length > 0
            }
            onChange={(e) => setDraft((d) => ({ ...d, addressId: e.target.value }))}
          >
            {boot.addresses
              .filter((a) => a.enabled && a.send_enabled)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} &lt;{a.email}&gt;
                </option>
              ))}
          </select>
        </div>
        <div className="compose-field">
          <label htmlFor="to">To</label>
          <input
            disabled={busy}
            id="to"
            list="contacts"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@example.com"
          />
          <button onClick={() => setExpanded(!expanded)}>Cc / Bcc</button>
        </div>
        <datalist id="contacts">
          {boot.contacts.map((c) => (
            <option key={c.email} value={c.email}>
              {c.name}
            </option>
          ))}
        </datalist>
        {expanded && (
          <>
            <div className="compose-field">
              <label htmlFor="cc">Cc</label>
              <input disabled={busy} id="cc" value={cc} onChange={(e) => setCc(e.target.value)} />
            </div>
            <div className="compose-field">
              <label htmlFor="bcc">Bcc</label>
              <input
                disabled={busy}
                id="bcc"
                value={bcc}
                onChange={(e) => setBcc(e.target.value)}
              />
            </div>
          </>
        )}
        <div className="compose-field">
          <label htmlFor="subject">Subject</label>
          <input
            disabled={busy}
            id="subject"
            value={draft.subject}
            onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
            placeholder="Give your message a subject"
          />
        </div>
        <textarea
          aria-label="Message body"
          className="compose-body"
          disabled={busy}
          autoFocus
          value={draft.text}
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
          placeholder="Write something thoughtful…"
        />
        {files.length > 0 && (
          <div className="compose-files">
            {files.map((f) => (
              <span key={f.id}>
                <Paperclip size={13} />
                {f.filename} · {bytes(f.size)}
                <button
                  title="Remove attachment"
                  onClick={() => {
                    setFiles((fs) => fs.filter((x) => x.id !== f.id));
                    setDraft((d) => ({
                      ...d,
                      attachments: d.attachments.filter((id) => id !== f.id),
                    }));
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <footer>
          <button
            className="primary"
            disabled={busy || !to.trim()}
            onClick={async () => {
              setBusy(true);
              clearTimeout(saveTimer.current);
              try {
                const saved = await save();
                await api(`/messages/${saved.id}/send`, 'POST', { revision: saved.revision });
                sent(saved.id);
              } catch (e) {
                notify((e as Error).message);
                setBusy(false);
              }
            }}
          >
            <Send size={16} /> {busy ? 'Sending…' : 'Send message'}
          </button>
          <button title="Attach files" disabled={busy} onClick={() => upload.current?.click()}>
            <Paperclip size={20} />
          </button>
          <input
            ref={upload}
            type="file"
            multiple
            hidden
            onChange={async (e) => {
              setBusy(true);
              try {
                for (const file of Array.from(e.target.files || [])) {
                  if (file.size > 3 * 1024 * 1024)
                    throw new Error('Each file must be 3 MiB or less');
                  const r = await fetch(`/api/attachments?address=${draft.addressId}`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': file.type || 'application/octet-stream',
                      'X-Filename': file.name,
                      'X-Postbox-Request': '1',
                    },
                    body: file,
                  });
                  const p = (await r.json()) as {
                    id: string;
                    filename: string;
                    size: number;
                    error?: string;
                  };
                  if (!r.ok) throw new Error(p.error);
                  setFiles((fs) => [...fs, p]);
                  setDraft((d) => ({ ...d, attachments: [...d.attachments, p.id] }));
                }
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
                e.target.value = '';
              }
            }}
          />
          <span>
            Sending as <strong>{from.email}</strong>
          </span>
        </footer>
      </section>
    </div>
  );
}
function SettingsPanel({
  theme,
  setTheme,
  tab,
  setTab,
  boot,
  close,
  reload,
  notify,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  tab: string;
  setTab: (s: string | null) => void;
  boot: Bootstrap;
  close: () => void;
  reload: () => void;
  notify: (s: string) => void;
}) {
  const dialogRef = useDialogFocus();
  const [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [signature, setSignature] = useState(''),
    [editing, setEditing] = useState<MailAddress | null>(null),
    [ruleField, setRuleField] = useState('sender'),
    [ruleAction, setRuleAction] = useState('archive');
  const receivingDomains = boot.local
    ? [{ name: 'studio.example', addressCreation: 'catch-all' }, ...boot.domains]
    : boot.domains.filter((d) => d.receiving);
  const selectedDomain = receivingDomains.find((d) => d.name === (email.split('@')[1] || ''));
  const canCreate =
    !!selectedDomain &&
    ['catch-all', 'managed-route'].includes(selectedDomain.addressCreation || '');
  const createDomains = receivingDomains.filter((d) =>
    ['catch-all', 'managed-route'].includes(d.addressCreation || ''),
  );
  const [intakes, setIntakes] = useState<
    { id: string; from_address: string; to_address: string; error: string }[]
  >([]);
  useEffect(() => {
    if (tab === 'health')
      api<{ intakes: typeof intakes }>('/intakes')
        .then((r) => setIntakes(r.intakes))
        .catch((e) => notify(e.message));
  }, [tab, boot.failedIntakes]);
  const tabs = [
    ['addresses', 'Mail addresses', Mail],
    ['contacts', 'Contacts', Users],
    ['labels', 'Labels', Tag],
    ['rules', 'Mail rules', SlidersHorizontal],
    ['health', 'Mail processing', RefreshCw],
    ['appearance', 'Appearance', Moon],
    ['workspace', 'Workspace', ShieldAlert],
  ] as const;
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      notify(msg);
      reload();
      setName('');
      setEmail('');
      setSignature('');
      setEditing(null);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Mailbox settings"
      >
        <header>
          <div>
            <span className="eyebrow">YOUR WORKSPACE</span>
            <h2>Settings</h2>
          </div>
          <button aria-label="Close settings" onClick={close}>
            <X size={20} />
          </button>
        </header>
        <div className="settings-layout">
          <nav>
            {tabs.map(([id, label, Icon]) => (
              <button
                key={id}
                className={id === tab ? 'active' : ''}
                onClick={() => {
                  setTab(id);
                  setEditing(null);
                  setName('');
                  setEmail('');
                }}
              >
                <Icon size={17} />
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {tab === 'addresses' && (
              <>
                <h3>A home for every address.</h3>
                <p className="muted">
                  Each address has its own inbox. All inboxes brings them together.
                </p>
                <div className="settings-cards">
                  {boot.addresses.map((a) => (
                    <div className="address-card" key={a.id}>
                      <span
                        className="avatar"
                        style={{ background: a.color + '18', color: a.color }}
                      >
                        <Mail size={19} />
                      </span>
                      <div>
                        <strong>{a.name}</strong>
                        <p>{a.email}</p>
                        <small>
                          {a.enabled ? 'Active' : 'Paused'} ·{' '}
                          {a.send_enabled ? 'Sending enabled' : 'Receive only'}
                        </small>
                      </div>
                      <button
                        aria-label={`Edit ${a.email}`}
                        title="Edit address"
                        onClick={() => {
                          setEditing(a);
                          setName(a.name);
                          setEmail(a.email);
                          setSignature(a.signature);
                        }}
                      >
                        <PenLine size={16} />
                      </button>
                      <button
                        title={a.enabled ? 'Pause address' : 'Resume address'}
                        onClick={() =>
                          act(
                            () => api(`/addresses/${a.id}`, 'PATCH', { enabled: !a.enabled }),
                            a.enabled ? 'Address paused' : 'Address resumed',
                          )
                        }
                      >
                        <span aria-label={a.enabled ? 'Pause' : 'Resume'}>
                          {a.enabled ? <Pause size={16} /> : <Play size={16} />}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!editing && !canCreate) {
                      notify('Choose a domain enabled for browser address creation.');
                      return;
                    }
                    act(
                      () =>
                        api(
                          editing ? `/addresses/${editing.id}` : '/addresses',
                          editing ? 'PATCH' : 'POST',
                          editing
                            ? { name, signature }
                            : { email, name, signature, color: '#8272d5' },
                        ),
                      editing ? 'Address updated' : 'Address added',
                    );
                  }}
                >
                  <h4>{editing ? 'Edit address' : 'Add a mail address'}</h4>
                  {!editing && (
                    <div className="address-domain-status">
                      <p>
                        Choose an enabled domain below. Catch-all domains create a working alias
                        immediately.
                      </p>
                      {receivingDomains.map((d) => (
                        <div key={d.name}>
                          <strong>{d.name}</strong>
                          <span>
                            {d.addressCreation === 'catch-all'
                              ? 'Ready · catch-all'
                              : d.addressCreation === 'managed-route'
                                ? 'Ready · automatic routing'
                                : 'CLI setup required'}
                          </span>
                        </div>
                      ))}
                      {createDomains.length === 0 && (
                        <p role="status">
                          Browser address creation needs a catch-all domain or managed routing. Run{' '}
                          <code>postbox init --reconfigure</code>, select catch-all for an apex mail
                          domain, then <code>postbox deploy</code>. Existing addresses continue to
                          work.
                        </p>
                      )}
                      <label>
                        Mail domain
                        <select
                          aria-label="Mail domain"
                          value={selectedDomain?.name || ''}
                          onChange={(e) =>
                            setEmail(`${email.split('@')[0] || ''}@${e.target.value}`)
                          }
                        >
                          <option value="">Choose a domain</option>
                          {receivingDomains.map((d) => (
                            <option
                              key={d.name}
                              value={d.name}
                              disabled={
                                !['catch-all', 'managed-route'].includes(d.addressCreation || '')
                              }
                            >
                              {d.name}
                              {['catch-all', 'managed-route'].includes(d.addressCreation || '')
                                ? ''
                                : ' · CLI setup required'}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}

                  <label>
                    Display name
                    <input
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Personal, work, shopping…"
                    />
                  </label>
                  <label>
                    Email address
                    <input
                      type="email"
                      required
                      disabled={!!editing}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@yourdomain.com"
                    />
                  </label>
                  {!editing && (
                    <button
                      disabled={!createDomains.length}
                      className="text-button"
                      type="button"
                      onClick={() =>
                        setEmail(
                          `mail-${crypto.randomUUID().slice(0, 8)}@${(canCreate ? selectedDomain : createDomains[0])?.name || ''}`,
                        )
                      }
                    >
                      Generate a random address
                    </button>
                  )}
                  <label>
                    Signature
                    <textarea
                      value={signature}
                      onChange={(e) => setSignature(e.target.value)}
                      placeholder="Your sign-off"
                    />
                  </label>
                  {editing && (
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={!!editing.send_enabled}
                        onChange={(e) => {
                          act(
                            () =>
                              api(`/addresses/${editing.id}`, 'PATCH', {
                                send_enabled: e.target.checked,
                              }),
                            e.target.checked ? 'Sending enabled' : 'Receive only',
                          );
                          setEditing({ ...editing, send_enabled: Number(e.target.checked) });
                        }}
                      />
                      Allow sending from this address
                    </label>
                  )}
                  <button className="primary" type="submit" disabled={!editing && !canCreate}>
                    <Plus size={16} />
                    {editing ? 'Save changes' : 'Add address'}
                  </button>
                  {editing && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(null);
                        setName('');
                        setEmail('');
                        setSignature('');
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </form>
              </>
            )}
            {tab === 'contacts' && (
              <>
                <h3>Your people.</h3>
                <p className="muted">Contacts appear as suggestions when composing.</p>
                {boot.contacts.map((c) => (
                  <div className="contact-row" key={c.email}>
                    <span className="avatar tone-0">{initials(c.name || c.email)}</span>
                    <div>
                      <strong>{c.name || c.email}</strong>
                      <p>{c.email}</p>
                    </div>
                    <button
                      title="Remove contact"
                      onClick={() =>
                        act(
                          () => api(`/contacts?email=${encodeURIComponent(c.email)}`, 'DELETE'),
                          'Contact removed',
                        )
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(() => api('/contacts', 'POST', { name, email }), 'Contact saved');
                  }}
                >
                  <label>
                    Name
                    <input value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <label>
                    Email
                    <input
                      required
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </label>
                  <button className="primary">Add contact</button>
                </form>
              </>
            )}
            {tab === 'labels' && (
              <>
                <h3>A little organization.</h3>
                {boot.labels.map((l) => (
                  <div className="contact-row" key={l.id}>
                    <span className="color-dot" style={{ background: l.color }} />
                    {l.name}
                    <button
                      title="Delete label"
                      onClick={() => act(() => api(`/labels/${l.id}`, 'DELETE'), 'Label removed')}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(() => api('/labels', 'POST', { name, color: '#8272d5' }), 'Label created');
                  }}
                >
                  <label>
                    Label name
                    <input required value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <button className="primary">Create label</button>
                </form>
              </>
            )}
            {tab === 'rules' && (
              <>
                <h3>Let your inbox sort itself.</h3>
                <p className="muted">Rules apply to new incoming mail.</p>
                {boot.rules.map((r) => (
                  <div className="contact-row" key={r.id}>
                    <SlidersHorizontal size={17} />
                    <div>
                      <strong>
                        {r.field} {r.operator} “{r.value}”
                      </strong>
                      <p>
                        {r.action}
                        {r.action_value ? ` · ${r.action_value}` : ''}
                      </p>
                    </div>
                    <button
                      title="Delete rule"
                      onClick={() => act(() => api(`/rules/${r.id}`, 'DELETE'), 'Rule removed')}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(
                      () =>
                        api('/rules', 'POST', {
                          field: ruleField,
                          operator: 'contains',
                          value: name,
                          action: ruleAction,
                          action_value: email,
                        }),
                      'Rule created',
                    );
                  }}
                >
                  <label>
                    Match
                    <select value={ruleField} onChange={(e) => setRuleField(e.target.value)}>
                      <option value="sender">Sender contains</option>
                      <option value="recipient">Recipient contains</option>
                      <option value="subject">Subject contains</option>
                    </select>
                    <input
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Text to match"
                    />
                  </label>
                  <label>
                    Then
                    <select value={ruleAction} onChange={(e) => setRuleAction(e.target.value)}>
                      <option value="archive">Archive</option>
                      <option value="spam">Move to spam</option>
                      <option value="label">Apply label</option>
                    </select>
                  </label>
                  {ruleAction === 'label' && (
                    <label>
                      Label
                      <select required value={email} onChange={(e) => setEmail(e.target.value)}>
                        <option value="">Choose label</option>
                        {boot.labels.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button className="primary">Add rule</button>
                </form>
              </>
            )}
            {tab === 'health' && (
              <>
                <h3>Mail processing</h3>
                <p className="muted">
                  Original mail is retained when parsing fails. Download it to inspect the MIME
                  message, or retry after fixing the cause.
                </p>
                {!intakes.length ? (
                  <p>No failed incoming messages.</p>
                ) : (
                  intakes.map((i) => (
                    <div className="info-card" key={i.id}>
                      <div>
                        <strong>
                          {i.from_address} → {i.to_address}
                        </strong>
                        <p>{i.error}</p>
                        <a className="button" href={`/api/intakes/${i.id}/raw`}>
                          Download original
                        </a>
                        <button
                          onClick={() =>
                            act(
                              () => api(`/intakes/${i.id}/retry`, 'POST', {}),
                              'Intake will be retried',
                            )
                          }
                        >
                          Retry intake
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </>
            )}
            {tab === 'appearance' && (
              <>
                <h3>Make yourself comfortable.</h3>
                <p className="muted">
                  Choose light, dark, or follow your device. Your preference is saved in this
                  browser.
                </p>
                <label className="theme-setting">
                  Theme
                  <select
                    aria-label="Color theme"
                    value={theme}
                    onChange={(e) => setTheme(e.target.value as Theme)}
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
              </>
            )}
            {tab === 'workspace' && (
              <>
                <h3>Private by design.</h3>
                <p className="muted">Your mail belongs in your own Cloudflare account.</p>
                <div className="info-card">
                  <ShieldAlert size={22} />
                  <div>
                    <strong>{boot.local ? 'Local preview' : 'Cloudflare Access protected'}</strong>
                    <p>
                      {boot.local
                        ? 'All sample messages and simulated sends stay local.'
                        : `Signed in as ${boot.user}. Access policies control who can enter.`}
                    </p>
                  </div>
                </div>
                <dl>
                  <dt>Resource prefix</dt>
                  <dd>{boot.prefix}</dd>
                  <dt>Remote images</dt>
                  <dd>Blocked</dd>
                  <dt>Public file access</dt>
                  <dd>Disabled</dd>
                  <dt>Mail storage</dt>
                  <dd>Your private R2 bucket and D1 database</dd>
                </dl>
                <h4>Configured domains</h4>
                {boot.domains.length ? (
                  boot.domains.map((d) => (
                    <div className="contact-row" key={d.name}>
                      <Mail size={17} />
                      <div>
                        <strong>{d.name}</strong>
                        <p>
                          {d.receiving ? 'Receiving configured' : 'Receiving disabled'} ·{' '}
                          {d.sending ? 'Sending configured' : 'Sending disabled'}
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="muted">Domain setup is configured during installation.</p>
                )}
                <a className="button" href="/api/export">
                  <Download size={16} />
                  Export mailbox metadata
                </a>
                <p className="muted">
                  Use the project's export tool for a complete backup including message bodies and
                  attachments.
                </p>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
