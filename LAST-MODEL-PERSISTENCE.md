# v0.4.35 — Último modelo usado

A preferência do último modelo selecionado no chat é persistida localmente em `localStorage` com providerID + modelID. Ao carregar/abrir um projeto e atualizar o catálogo de providers, a Neko restaura o modelo salvo somente se o provider estiver conectado, o provider estiver ativo e o modelo estiver habilitado. Caso não esteja disponível, seleciona o primeiro modelo ativo disponível e atualiza a preferência.

A preferência não é gravada dentro do projeto e não altera arquivos do usuário.
