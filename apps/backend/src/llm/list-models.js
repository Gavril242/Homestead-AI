import 'dotenv/config';

async function list() {
  const key = process.env.GEMINI_KEY_1;
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

list();
