import { statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { CliError, clean, messageId, resolveAddress, displayMessage } from './mail-client.mjs';
const recipients = (items = []) =>
  items
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean);
export async function executeMail(
  command,
  values,
  positional,
  { api, interactive, ask, log = console.log },
) {
  const bootstrap = await api('/api/bootstrap');
  if (command === 'list') {
    const folder = values.folder || (interactive ? await ask('Folder', 'inbox') : 'inbox');
    if (!['inbox', 'sent', 'draft', 'archive', 'spam', 'trash', 'starred', 'all'].includes(folder))
      throw new CliError('INVALID_FOLDER', 'Unknown folder');
    const offset = Number(values.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new CliError('INVALID_OFFSET', 'Offset must be a nonnegative integer');
    const query = new URLSearchParams({ folder, offset: String(offset) });
    if (values.address)
      query.set('address', resolveAddress(bootstrap.addresses, values.address).id);
    if (values.q) query.set('q', values.q);
    if (values.unread) query.set('unread', '1');
    if (values.attachments) query.set('attachments', '1');
    const result = await api(`/api/messages?${query}`);
    return {
      ...result,
      messages: result.messages.map((m) =>
        Object.fromEntries(
          [
            'id',
            'address_id',
            'address_email',
            'folder',
            'direction',
            'from_address',
            'from_name',
            'subject',
            'snippet',
            'received_at',
            'is_read',
            'starred',
            'status',
            'attachment_count',
            'revision',
          ]
            .filter((k) => m[k] !== undefined)
            .map((k) => [k, m[k]]),
        ),
      ),
      nextOffset:
        offset + result.messages.length < result.total ? offset + result.messages.length : null,
    };
  }
  let id = values.id || positional[0];
  if (command === 'view' || command === 'send') {
    if (!id && interactive) id = await ask('Message UUID');
    id = messageId(id);
    const message = await api(`/api/messages/${id}`);
    if (command === 'view')
      return Object.fromEntries(
        [
          'id',
          'revision',
          'address_id',
          'address_email',
          'folder',
          'direction',
          'status',
          'error',
          'from_address',
          'from_name',
          'to_json',
          'cc_json',
          'bcc_json',
          'reply_to_json',
          'subject',
          'text',
          'truncated',
          'received_at',
          'is_read',
          'starred',
          'attachments',
          'delivery',
          'reply_id',
          'forward_id',
        ]
          .filter((k) => message[k] !== undefined)
          .map((k) => [k, message[k]]),
      );
    if (message.folder !== 'draft' || message.status !== 'draft')
      throw new CliError(
        'NOT_A_DRAFT',
        'Only a saved draft can be sent. Inspect its status before retrying a send.',
      );
    if (!values.yes) {
      if (!interactive)
        throw new CliError(
          'CONFIRMATION_REQUIRED',
          'Send requires --yes in non-interactive mode. Use postbox view ID to review first.',
        );
      log(displayMessage(message));
      if ((await ask('Send this exact draft? yes/no', 'no')) !== 'yes')
        return { cancelled: true, id };
    }
    const sent = await api(`/api/messages/${id}/send`, 'POST', { revision: message.revision });
    return { messageId: id, jobId: sent.id, status: sent.status };
  }
  let from = values.from;
  if (!from && interactive) {
    log(
      bootstrap.addresses
        .filter((a) => a.enabled)
        .map((a) => a.email)
        .join('\n'),
    );
    from = await ask('From mailbox');
  }
  const address = resolveAddress(bootstrap.addresses, from, true);
  const to = values.to || (interactive ? [await ask('To, comma separated')] : []);
  const subject = values.subject ?? (interactive ? await ask('Subject') : '');
  if (values.body !== undefined && values['body-file'])
    throw new CliError('INVALID_BODY', 'Choose --body or --body-file');
  let text = values.body;
  if (values['body-file']) {
    const file = values['body-file'];
    if (file === '-' && process.stdin.isTTY)
      throw new CliError('INVALID_BODY', 'Pipe body text into stdin, or use a body file');
    if (file !== '-' && statSync(file).size > 800000)
      throw new CliError('INVALID_BODY', 'Body file is too large');
    // Bound stdin as well; never consume unlimited input from a pipe.
    const { openSync, readSync, closeSync } = await import('node:fs');
    const fd = file === '-' ? 0 : openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(800001);
      let size = 0,
        count;
      while (
        size < buffer.length &&
        (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0
      )
        size += count;
      if (size > 800000) throw new CliError('INVALID_BODY', 'Body file is too large');
      text = buffer.subarray(0, size).toString('utf8');
    } finally {
      if (file !== '-') closeSync(fd);
    }
  }
  if (text === undefined)
    text = interactive ? await ask('Body (one line; use --body-file for multiple lines)') : '';
  const draft = {
    addressId: address.id,
    to: recipients(to),
    cc: recipients(values.cc),
    bcc: recipients(values.bcc),
    subject,
    text,
    attachments: [],
  };
  if (id) {
    id = messageId(id);
    const old = await api(`/api/messages/${id}`);
    if (old.folder !== 'draft') throw new CliError('NOT_A_DRAFT', 'Only drafts can be edited');
    // Explicit replacement rather than silently wiping unspecified fields.
    if (
      !interactive &&
      (values.subject === undefined ||
        (values.body === undefined && !values['body-file']) ||
        !values.to)
    )
      throw new CliError(
        'INVALID_DRAFT',
        'Updating requires explicit --from, --to, --subject and --body/--body-file',
      );
    if (old.reply_id) draft.replyToMessageId = old.reply_id;
    if (old.forward_id) draft.forwardMessageId = old.forward_id;
    Object.assign(draft, {
      id,
      revision: old.revision,
      attachments: (old.attachments || []).map((a) => a.id),
    });
  }
  if (values['reply-to']) draft.replyToMessageId = messageId(values['reply-to']);
  return {
    ...(await api('/api/drafts', 'POST', draft)),
    status: 'draft',
    review: 'Open Drafts in the web mailbox, or use postbox view ID. Nothing has been sent.',
  };
}
export async function runTui(api) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label, fallback = '') =>
    (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
  const log = (value) => console.log(clean(value));
  let folder = 'inbox',
    offset = 0,
    messages = [];
  let restored = false;
  const restore = () => {
    if (!restored) {
      restored = true;
      process.stdout.write('\x1b[?1049l');
    }
  };
  const interrupt = () => process.exit(130);
  const terminate = () => process.exit(143);
  process.on('exit', restore);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  rl.on('SIGINT', interrupt);
  process.stdout.write('\x1b[?1049h');
  try {
    while (true) {
      const page = await api(
        `/api/messages?${new URLSearchParams({ folder, offset: String(offset) })}`,
      );
      messages = page.messages;
      process.stdout.write('\x1b[2J\x1b[H');
      log(`POSTBOX — ${folder} — ${offset + 1}–${offset + messages.length} of ${page.total}\n`);
      messages.forEach((m, i) =>
        log(
          `${i + 1}. ${m.is_read ? ' ' : '*'} ${m.address_email} | ${m.from_address} | ${m.subject}`,
        ),
      );
      log('\n[number] view  [c] compose draft  [s] send draft  [f] folder  [n/p] page  [q] quit');
      const action = await ask('>');
      try {
        if (action === 'q') break;
        if (action === 'n') {
          if (offset + 50 < page.total) offset += 50;
          continue;
        }
        if (action === 'p') {
          offset = Math.max(0, offset - 50);
          continue;
        }
        if (action === 'f') {
          const value = await ask('inbox/sent/draft/archive/spam/trash/all', folder);
          if (['inbox', 'sent', 'draft', 'archive', 'spam', 'trash', 'all'].includes(value)) {
            folder = value;
            offset = 0;
          }
          continue;
        }
        if (action === 'c' || action === 's')
          log(
            JSON.stringify(
              await executeMail(action === 'c' ? 'draft' : 'send', {}, [], {
                api,
                interactive: true,
                ask,
                log,
              }),
              null,
              2,
            ),
          );
        else if (/^\d+$/.test(action) && messages[Number(action) - 1])
          log(displayMessage(await api(`/api/messages/${messages[Number(action) - 1].id}`)));
        else log('Choose a listed command or message number.');
      } catch (error) {
        log(error.message);
      }
      await ask('Enter to continue');
    }
  } finally {
    rl.close();
    restore();
    process.off('exit', restore);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
