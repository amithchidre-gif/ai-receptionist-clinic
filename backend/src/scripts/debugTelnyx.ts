import Telnyx from 'telnyx';

async function main() {
  const client = new Telnyx(process.env.TELNYX_API_KEY!);
  try {
    const r = await (client.messages.create as (p: unknown) => Promise<{ data: unknown }>)({
      from: '+19257097010',
      to: '+19257097010',
      text: 'test ping',
    });
    console.log('OK', JSON.stringify(r.data, null, 2));
  } catch (e: unknown) {
    const err = e as { message?: string; status?: number; raw?: unknown };
    console.error('ERROR:', err.message);
    console.error('HTTP STATUS:', err.status);
    console.error('RAW:', JSON.stringify(err.raw, null, 2));
  }
  process.exit(0);
}

main();
