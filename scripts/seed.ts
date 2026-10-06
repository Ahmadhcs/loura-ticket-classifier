import { readFile } from 'node:fs/promises';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3000';

const raw = await readFile(new URL('../data/sample_tickets.json', import.meta.url), 'utf8');
const tickets = JSON.parse(raw) as { id: string; subject: string; body: string }[];

let failed = false;

for (const ticket of tickets) {
    const res = await fetch(`${baseUrl}/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ticket),
    });
    console.log(`${ticket.id} ${res.status}`);
    if (!res.ok) {
        failed = true;
        console.error(await res.text());
    }
}

if (failed) {
    process.exit(1);
}
