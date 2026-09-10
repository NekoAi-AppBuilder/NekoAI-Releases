// ============================================================
// TUTORIAIS DO NEKOAI (dados centralizados)
// ------------------------------------------------------------
// Cada tutorial abre EXTERNAMENTE no navegador padrão ("Ver no YouTube") —
// não há player/iframe interno. As thumbnails ficam em public/tutorials
// (referenciadas de forma relativa, sem caminho absoluto da máquina).
// Adicione novos vídeos apenas aqui, sem duplicar componentes.
// ============================================================

export type NekoTutorial = {
  videoId: string;
  youtubeUrl: string;
  title: string;
  description: string;
  thumb: string; // caminho relativo da thumbnail local (public/tutorials)
};

const THUMB = (n: number) => `./tutorials/tutorial-${n}.jpg`;

const TUTORIALS: NekoTutorial[] = [
  {
    videoId: "xGTqcjPrlbM",
    youtubeUrl: "https://www.youtube.com/watch?v=xGTqcjPrlbM",
    title: "NekoAI - Como instalar no seu computador",
    description: "Aprenda a instalar o NekoAI no seu computador e deixar o ambiente pronto para começar.",
    thumb: THUMB(1)
  },
  {
    videoId: "vdcF2t8UaZk",
    youtubeUrl: "https://www.youtube.com/watch?v=vdcF2t8UaZk",
    title: "NekoAI - Criando um projeto do zero com várias IAs gratuitas",
    description: "Veja como criar um projeto do zero utilizando diferentes modelos de IA disponíveis no NekoAI.",
    thumb: THUMB(2)
  },
  {
    videoId: "9S4hn7c1NpA",
    youtubeUrl: "https://www.youtube.com/watch?v=9S4hn7c1NpA",
    title: "NekoAI - Como conectar seu GitHub a um projeto do NekoAI",
    description: "Aprenda a conectar seu GitHub ao NekoAI para trabalhar com seus projetos e código.",
    thumb: THUMB(3)
  },
  {
    videoId: "Ba33znTB124",
    youtubeUrl: "https://www.youtube.com/watch?v=Ba33znTB124",
    title: "NekoAI - Como integrar a Vercel com domínio próprio",
    description: "Veja como publicar seu projeto na Vercel e configurar um domínio próprio.",
    thumb: THUMB(4)
  },
  {
    videoId: "m8cYkvo9Xzo",
    youtubeUrl: "https://www.youtube.com/watch?v=m8cYkvo9Xzo",
    title: "NekoAI - Como integrar o banco de dados Supabase",
    description: "Aprenda a conectar o Supabase ao seu projeto e configurar seu banco de dados.",
    thumb: THUMB(5)
  },
  {
    videoId: "LMmcFWRY-Sk",
    youtubeUrl: "https://www.youtube.com/watch?v=LMmcFWRY-Sk",
    title: "NekoAI - Como editar projetos do Lovable sem gastar créditos",
    description: "Aprenda a abrir e editar projetos criados no Lovable diretamente pelo NekoAI.",
    thumb: THUMB(6)
  }
];

export function getNekoTutorials(): NekoTutorial[] {
  return TUTORIALS;
}
