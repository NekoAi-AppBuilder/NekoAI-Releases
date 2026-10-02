import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getPullRequestStatus,
  listPullRequests,
  mergePullRequest,
  NekoPullRequestStatus
} from "../src/main/github/pull-request-manager";

// Mock de fetch global para simular respostas da API REST do GitHub
const originalFetch = globalThis.fetch;

describe("GitHub Pull Request + Smart Merge Manager", () => {
  let mockFetchHandlers: Array<{
    urlPattern: RegExp | string;
    method?: string;
    response: { status: number; data: any };
  }> = [];

  beforeEach(() => {
    mockFetchHandlers = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || "GET").toUpperCase();

      for (const handler of mockFetchHandlers) {
        const matchesUrl = typeof handler.urlPattern === "string"
          ? urlStr.includes(handler.urlPattern)
          : handler.urlPattern.test(urlStr);
        const matchesMethod = !handler.method || handler.method.toUpperCase() === method;

        if (matchesUrl && matchesMethod) {
          return new Response(JSON.stringify(handler.response.data), {
            status: handler.response.status,
            headers: { "Content-Type": "application/vnd.github+json" }
          });
        }
      }

      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/vnd.github+json" }
      });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("1. Retorna erro ao passar formato de repositório inválido", async () => {
    const res = await getPullRequestStatus({
      repoFullName: "invalid-repo-name",
      headBranch: "feature",
      baseBranch: "main",
      token: "test-token"
    });

    expect(res.ok).toBe(false);
    expect(res.state).toBe("PR_UNKNOWN");
    expect(res.error).toContain("Repositório do GitHub inválido");
  });

  test("2. Retorna erro ao omitir headBranch ou baseBranch", async () => {
    const res = await getPullRequestStatus({
      repoFullName: "owner/repo",
      headBranch: "",
      baseBranch: "main",
      token: "test-token"
    });

    expect(res.ok).toBe(false);
    expect(res.state).toBe("PR_UNKNOWN");
    expect(res.error).toContain("Branch de origem e destino são obrigatórias");
  });

  test("3. Classifica estado como NO_PR quando nenhuma PR existe no GitHub", async () => {
    mockFetchHandlers.push({
      urlPattern: "/pulls?head=revendedor&base=main",
      response: { status: 200, data: [] }
    });

    const res = await getPullRequestStatus({
      repoFullName: "owner/repo",
      headBranch: "revendedor",
      baseBranch: "main",
      token: "test-token"
    });

    expect(res.ok).toBe(true);
    expect(res.state).toBe("NO_PR");
  });

  test("4. Classifica PR em DRAFT como PR_BLOCKED", async () => {
    mockFetchHandlers.push(
      {
        urlPattern: "/pulls?head=revendedor&base=main",
        response: { status: 200, data: [{ number: 12 }] }
      },
      {
        urlPattern: "/pulls/12",
        response: {
          status: 200,
          data: {
            number: 12,
            title: "Draft PR",
            draft: true,
            state: "open",
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: "abc1234", ref: "revendedor" },
            base: { ref: "main" }
          }
        }
      }
    );

    const res = await getPullRequestStatus({
      repoFullName: "owner/repo",
      headBranch: "revendedor",
      baseBranch: "main",
      token: "test-token"
    });

    expect(res.ok).toBe(true);
    expect(res.state).toBe("PR_BLOCKED");
    expect(res.draft).toBe(true);
  });

  test("5. Classifica PR com conflitos como PR_CONFLICTS", async () => {
    mockFetchHandlers.push(
      {
        urlPattern: "/pulls?head=feature&base=main",
        response: { status: 200, data: [{ number: 5 }] }
      },
      {
        urlPattern: "/pulls/5",
        response: {
          status: 200,
          data: {
            number: 5,
            title: "Conflicting PR",
            draft: false,
            state: "open",
            mergeable: false,
            mergeable_state: "dirty",
            head: { sha: "def5678", ref: "feature" },
            base: { ref: "main" }
          }
        }
      }
    );

    const res = await getPullRequestStatus({
      repoFullName: "owner/repo",
      headBranch: "feature",
      baseBranch: "main",
      token: "test-token"
    });

    expect(res.ok).toBe(true);
    expect(res.state).toBe("PR_CONFLICTS");
    expect(res.hasConflicts).toBe(true);
  });

  test("6. Classifica PR com checks reprovados como PR_BLOCKED", async () => {
    mockFetchHandlers.push(
      {
        urlPattern: "/pulls?head=feature&base=main",
        response: { status: 200, data: [{ number: 7 }] }
      },
      {
        urlPattern: "/pulls/7",
        response: {
          status: 200,
          data: {
            number: 7,
            title: "Failed Checks PR",
            draft: false,
            state: "open",
            mergeable: true,
            mergeable_state: "unstable",
            head: { sha: "sha777", ref: "feature" },
            base: { ref: "main" }
          }
        },
      },
      {
        urlPattern: "/commits/sha777/check-runs",
        response: {
          status: 200,
          data: {
            check_runs: [
              { name: "build", status: "completed", conclusion: "failure" }
            ]
          }
        }
      },
      {
        urlPattern: "/commits/sha777/status",
        response: { status: 200, data: { statuses: [] } }
      }
    );

    const res = await getPullRequestStatus({
      repoFullName: "owner/repo",
      headBranch: "feature",
      baseBranch: "main",
      token: "test-token"
    });

    expect(res.ok).toBe(true);
    expect(res.state).toBe("PR_BLOCKED");
    expect(res.checksFailed).toBe(true);
  });

  test("7. Classifica PR com checks aprovados e mergeable=true como PR_READY_TO_MERGE", async () => {
    mockFetchHandlers.push(
      {
        urlPattern: "/pulls?head=feature&base=main",
        response: { status: 200, data: [{ number: 10 }] }
      },
      {
        urlPattern: "/pulls/10",
        response: {
          status: 200,
          data: {
            number: 10,
            title: "Ready PR",
            draft: false,
            state: "open",
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: "sha1010", ref: "feature" },
            base: { ref: "main" }
          }
        }
      },
      {
        urlPattern: "/commits/sha1010/check-runs",
        response: {
          status: 200,
          data: {
            check_runs: [
              { name: "test", status: "completed", conclusion: "success" }
            ]
          }
        }
      },
      {
        urlPattern: "/commits/sha1010/status",
        response: { status: 200, data: { statuses: [] } }
      }
    );

    const res = await getPullRequestStatus({
      repoFullName: "owner/repo",
      headBranch: "feature",
      baseBranch: "main",
      token: "test-token"
    });

    expect(res.ok).toBe(true);
    expect(res.state).toBe("PR_READY_TO_MERGE");
    expect(res.checksApproved).toBe(true);
    expect(res.hasConflicts).toBe(false);
  });

  test("8. Classifica PR já mesclada como PR_MERGED", async () => {
    mockFetchHandlers.push(
      {
        urlPattern: "/pulls/33",
        response: {
          status: 200,
          data: {
            number: 33,
            title: "Merged PR",
            state: "closed",
            merged: true,
            merged_at: "2026-10-01T12:00:00Z",
            head: { ref: "feature" },
            base: { ref: "main" }
          }
        }
      }
    );

    const res = await getPullRequestStatus({
      repoFullName: "owner/repo",
      headBranch: "feature",
      baseBranch: "main",
      prNumber: 33,
      token: "test-token"
    });

    expect(res.ok).toBe(true);
    expect(res.state).toBe("PR_MERGED");
  });

  test("8.1. Classifica PR já mesclada como PR_MERGED via busca de lista quando prNumber omitido", async () => {
    mockFetchHandlers.push(
      {
        urlPattern: "/pulls?head=teste-aula&base=main&state=open",
        response: { status: 200, data: [] }
      },
      {
        urlPattern: "/pulls?head=teste-aula&base=main&state=all",
        response: { status: 200, data: [{ number: 1 }] }
      },
      {
        urlPattern: "/pulls/1",
        response: {
          status: 200,
          data: {
            number: 1,
            title: "Update from NekoAI",
            state: "closed",
            merged: true,
            merged_at: "2026-10-01T15:00:00Z",
            head: { ref: "teste-aula" },
            base: { ref: "main" }
          }
        }
      }
    );

    const res = await getPullRequestStatus({
      repoFullName: "NekoAI-AppBuilder/teste-aula",
      headBranch: "teste-aula",
      baseBranch: "main",
      token: "test-token"
    });

    expect(res.ok).toBe(true);
    expect(res.state).toBe("PR_MERGED");
    expect(res.prNumber).toBe(1);
    expect(res.headBranch).toBe("teste-aula");
    expect(res.baseBranch).toBe("main");
  });

  test("9. mergePullRequest executa o merge com sucesso quando PR está pronta", async () => {
    mockFetchHandlers.push(
      // Consulta prévia no getPullRequestStatus (antes do merge)
      {
        urlPattern: "/pulls/10",
        method: "GET",
        response: {
          status: 200,
          data: {
            number: 10,
            title: "PR Pronta",
            state: "open",
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: "sha1010", ref: "feature" },
            base: { ref: "main" }
          }
        }
      },
      {
        urlPattern: "/commits/sha1010/check-runs",
        method: "GET",
        response: { status: 200, data: { check_runs: [] } }
      },
      {
        urlPattern: "/commits/sha1010/status",
        method: "GET",
        response: { status: 200, data: { statuses: [] } }
      },
      // Chamada de merge PUT
      {
        urlPattern: "/pulls/10/merge",
        method: "PUT",
        response: {
          status: 200,
          data: { merged: true, message: "Pull Request successfully merged" }
        }
      }
    );

    const mergeRes = await mergePullRequest({
      repoFullName: "owner/repo",
      prNumber: 10,
      expectedHeadBranch: "feature",
      expectedBaseBranch: "main",
      token: "test-token"
    });

    expect(mergeRes.ok).toBe(true);
    expect(mergeRes.message).toContain("mesclada com sucesso");
  });

  test("10. mergePullRequest bloqueia a execução se a PR tiver conflitos", async () => {
    mockFetchHandlers.push(
      {
        urlPattern: "/pulls/50",
        method: "GET",
        response: {
          status: 200,
          data: {
            number: 50,
            state: "open",
            mergeable: false,
            mergeable_state: "dirty",
            head: { ref: "feature" },
            base: { ref: "main" }
          }
        }
      }
    );

    const mergeRes = await mergePullRequest({
      repoFullName: "owner/repo",
      prNumber: 50,
      expectedHeadBranch: "feature",
      expectedBaseBranch: "main",
      token: "test-token"
    });

    expect(mergeRes.ok).toBe(false);
    expect(mergeRes.error).toContain("existem conflitos");
  });

  test("11. mergePullRequest retorna sucesso antecipado se a PR já tiver sido mesclada", async () => {
    mockFetchHandlers.push(
      {
        urlPattern: "/pulls/99",
        method: "GET",
        response: {
          status: 200,
          data: {
            number: 99,
            state: "closed",
            merged: true,
            merged_at: "2026-10-01T10:00:00Z",
            head: { ref: "feature" },
            base: { ref: "main" }
          }
        }
      }
    );

    const mergeRes = await mergePullRequest({
      repoFullName: "owner/repo",
      prNumber: 99,
      expectedHeadBranch: "feature",
      expectedBaseBranch: "main",
      token: "test-token"
    });

    expect(mergeRes.ok).toBe(true);
    expect(mergeRes.message).toContain("já foi mesclada");
  });

  test("12. mergePullRequest trata erro HTTP 405 (branch protegida ou conflitos)", async () => {
    mockFetchHandlers.push(
      {
        urlPattern: "/pulls/88",
        method: "GET",
        response: {
          status: 200,
          data: {
            number: 88,
            state: "open",
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: "sha88", ref: "feature" },
            base: { ref: "main" }
          }
        }
      },
      {
        urlPattern: "/commits/sha88/check-runs",
        method: "GET",
        response: { status: 200, data: { check_runs: [] } }
      },
      {
        urlPattern: "/commits/sha88/status",
        method: "GET",
        response: { status: 200, data: { statuses: [] } }
      },
      {
        urlPattern: "/pulls/88/merge",
        method: "PUT",
        response: {
          status: 405,
          data: { message: "Pull Request is not mergeable" }
        }
      }
    );

    const mergeRes = await mergePullRequest({
      repoFullName: "owner/repo",
      prNumber: 88,
      expectedHeadBranch: "feature",
      expectedBaseBranch: "main",
      token: "test-token"
    });

    expect(mergeRes.ok).toBe(false);
    expect(mergeRes.error).toContain("Não foi possível mesclar a PR #88");
  });

  test("11. listPullRequests limita primeira página em no máximo 10 PRs e indica hasMore", async () => {
    const mockPulls = Array.from({ length: 10 }, (_, i) => ({
      number: i + 1,
      title: `PR ${i + 1}`,
      state: "closed",
      merged: true,
      merged_at: "2026-10-01T12:00:00Z",
      head: { ref: `feature-${i + 1}` },
      base: { ref: "main" }
    }));

    mockFetchHandlers.push({
      urlPattern: "/pulls?state=all&sort=updated&direction=desc&per_page=10&page=1",
      method: "GET",
      response: { status: 200, data: mockPulls }
    });

    const res = await listPullRequests({
      repoFullName: "owner/repo",
      token: "test-token",
      page: 1,
      perPage: 10
    });

    expect(res.ok).toBe(true);
    expect(res.prs.length).toBe(10);
    expect(res.hasMore).toBe(true);
    expect(res.prs[0].state).toBe("PR_MERGED");
  });

  test("12. listPullRequests retorna lista vazia quando não existem PRs no repositório", async () => {
    mockFetchHandlers.push({
      urlPattern: "/pulls?state=all&sort=updated&direction=desc&per_page=10&page=1",
      method: "GET",
      response: { status: 200, data: [] }
    });

    const res = await listPullRequests({
      repoFullName: "owner/repo",
      token: "test-token",
      page: 1,
      perPage: 10
    });

    expect(res.ok).toBe(true);
    expect(res.prs.length).toBe(0);
    expect(res.hasMore).toBe(false);
  });
});
