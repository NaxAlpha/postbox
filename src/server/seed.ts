import { emailHtml } from './security';
import { now } from './storage';
export async function seed(env: Env) {
  const done = await env.DB.prepare("SELECT key FROM settings WHERE key='local-seed'").first();
  if (done) return;
  const addresses = [
    { id: crypto.randomUUID(), email: 'hello@studio.example', name: 'Personal', color: '#8172d5' },
    { id: crypto.randomUUID(), email: 'work@studio.example', name: 'Work', color: '#42a697' },
    { id: crypto.randomUUID(), email: 'notes@studio.example', name: 'Notes', color: '#dfad54' },
  ];
  for (const a of addresses)
    await env.DB.prepare(
      'INSERT OR IGNORE INTO addresses(id,email,name,color,created_at,signature) VALUES(?,?,?,?,?,?)',
    )
      .bind(a.id, a.email, a.name, a.color, now(), a.name === 'Personal' ? 'Best,\nAlex' : '')
      .run();
  const samples = [
    [
      'Maya Chen',
      'maya@example.test',
      'A little inspiration for the weekend',
      'Hey Alex,\n\nI found a lovely little bookshop while walking yesterday. Thought you would appreciate the shelves of old design magazines and the excellent coffee.\n\nWant to stop by on Saturday?\n\nMaya',
      0,
      0,
    ],
    [
      'Oliver Park',
      'oliver@example.test',
      'The first draft is ready ✨',
      'Hi Alex,\n\nThe first draft is ready for your review. I kept the layout calm and focused, with a little more breathing room between the sections.\n\nLet me know what you think.\n\nOliver',
      1,
      0,
    ],
    [
      'The Design Letter',
      'letter@example.test',
      'Small details, big difference',
      'This week: making everyday tools feel a little more human.\n\nA well-placed label, a thoughtful empty state, and a button that says exactly what it does. Small things add up.\n\nEnjoy the read.',
      0,
      1,
    ],
    [
      'Jordan Lee',
      'jordan@example.test',
      'Lunch next Thursday?',
      'Hey!\n\nI will be in your neighborhood next Thursday. Are you around for lunch? There is a new place near the station I have been wanting to try.\n\nJordan',
      0,
      0,
    ],
    [
      'Sam Rivera',
      'sam@example.test',
      'Project notes · October',
      'Hi Alex,\n\nHere are the notes from our last conversation:\n\n• Simplify the onboarding\n• Give the inbox more breathing room\n• Keep the most useful actions within reach\n\nI will share the updated plan tomorrow.\n\nSam',
      1,
      1,
    ],
    [
      'Alex',
      'alex@example.test',
      'A thought to come back to',
      'The best tools stay out of the way.\n\nBuild something that feels familiar on the first day, and still feels useful on the hundredth.',
      2,
      0,
    ],
    [
      'Lena Morris',
      'lena@example.test',
      'Thanks for your help yesterday',
      'Hi Alex,\n\nJust a quick note to say thank you for taking the time yesterday. Your feedback made everything much clearer.\n\nHave a good week!\n\nLena',
      0,
      0,
    ],
  ] as const;
  for (let i = 0; i < samples.length; i++) {
    const [name, from, subject, text, ai, star] = samples[i],
      id = crypto.randomUUID(),
      key = `bodies/${id}.json`,
      date = new Date(Date.now() - i * 1000 * 3600 * 3).toISOString();
    await env.MAIL.put(key, JSON.stringify({ text, html: emailHtml(text) }));
    await env.DB.prepare(
      "INSERT INTO messages(id,address_id,thread_id,folder,direction,subject,from_address,from_name,to_json,snippet,received_at,is_read,starred,body_key,search_text,updated_at) VALUES(?,?,?,'inbox','inbound',?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        addresses[ai].id,
        id,
        subject,
        from,
        name,
        JSON.stringify([addresses[ai].email]),
        text.slice(0, 140),
        date,
        i > 2 ? 1 : 0,
        star,
        key,
        text,
        date,
      )
      .run();
    await env.DB.prepare('INSERT OR IGNORE INTO contacts(email,name) VALUES(?,?)')
      .bind(from, name)
      .run();
  }
  await env.DB.prepare('INSERT INTO labels(id,name,color) VALUES(?,?,?)')
    .bind(crypto.randomUUID(), 'Ideas', '#8172d5')
    .run();
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES('local-seed','1')").run();
}
