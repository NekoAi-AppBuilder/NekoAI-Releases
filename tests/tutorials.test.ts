// tests/tutorials.test.ts
// Verifica o mapeamento exato título/videoId/youtubeUrl/thumbnail dos 6
// tutoriais (abertura externa, sem player/iframe).
// Executar: node --experimental-strip-types --test tests/tutorials.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { getNekoTutorials } from "../src/renderer/tutorials.ts";

const EXPECTED = [
  { videoId: "xGTqcjPrlbM", title: "NekoAI - Como instalar no seu computador", thumb: "./tutorials/tutorial-1.jpg" },
  { videoId: "vdcF2t8UaZk", title: "NekoAI - Criando um projeto do zero com várias IAs gratuitas", thumb: "./tutorials/tutorial-2.jpg" },
  { videoId: "9S4hn7c1NpA", title: "NekoAI - Como conectar seu GitHub a um projeto do NekoAI", thumb: "./tutorials/tutorial-3.jpg" },
  { videoId: "Ba33znTB124", title: "NekoAI - Como integrar a Vercel com domínio próprio", thumb: "./tutorials/tutorial-4.jpg" },
  { videoId: "m8cYkvo9Xzo", title: "NekoAI - Como integrar o banco de dados Supabase", thumb: "./tutorials/tutorial-5.jpg" },
  { videoId: "LMmcFWRY-Sk", title: "NekoAI - Como editar projetos do Lovable sem gastar créditos", thumb: "./tutorials/tutorial-6.jpg" }
];

test("são exatamente 6 tutoriais", () => {
  assert.equal(getNekoTutorials().length, 6);
});

test("título/videoId/youtubeUrl/thumbnail coerentes por tutorial", () => {
  const list = getNekoTutorials();
  for (const exp of EXPECTED) {
    const t = list.find(x => x.videoId === exp.videoId);
    assert.ok(t, `videoId ${exp.videoId} deve existir`);
    assert.equal(t!.title, exp.title, `título de ${exp.videoId}`);
    assert.equal(t!.youtubeUrl, `https://www.youtube.com/watch?v=${exp.videoId}`, `url de ${exp.videoId}`);
    assert.equal(t!.thumb, exp.thumb, `thumbnail de ${exp.videoId}`);
    assert.ok(t!.description.length > 0, `descrição de ${exp.videoId}`);
  }
});

test("IDs únicos e thumbnails únicas", () => {
  const ids = getNekoTutorials().map(t => t.videoId);
  const thumbs = getNekoTutorials().map(t => t.thumb);
  assert.equal(new Set(ids).size, 6);
  assert.equal(new Set(thumbs).size, 6);
  for (const exp of EXPECTED) {
    assert.ok(ids.includes(exp.videoId));
    assert.ok(thumbs.includes(exp.thumb));
  }
});
