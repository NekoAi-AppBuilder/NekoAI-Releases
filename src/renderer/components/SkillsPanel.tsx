import React from "react";
import {
  Sparkles,
  X,
  Plus,
  Trash2,
  Loader2,
  AlertTriangle
} from "lucide-react";
import {
  SKILLS_CATALOG,
  type SkillStatusInfo,
  type SkillsProjectState
} from "../../main/skills/skills-catalog";

interface SkillsPanelProps {
  projectPath: string | null;
  skillsState: SkillsProjectState | null;
  isLoading: boolean;
  readOnly?: boolean;
  onClose: () => void;
  onInstall: (skillId: string) => Promise<void>;
  onRemove: (skillId: string) => Promise<void>;
  onRun: (skillId: string) => Promise<void>;
}

export function SkillsPanel({
  projectPath,
  skillsState,
  isLoading,
  readOnly = false,
  onClose,
  onInstall,
  onRemove,
  onRun
}: SkillsPanelProps) {
  const [selectedCategory, setSelectedCategory] = React.useState<string>("todos");
  const [actionBusySkillId, setActionBusySkillId] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  // Mapeamento dinâmico do estado de instalação das skills no projeto atual
  const installedStatusMap = React.useMemo(() => {
    const map = new Map<string, SkillStatusInfo>();
    if (skillsState?.skills && Array.isArray(skillsState.skills)) {
      for (const s of skillsState.skills) {
        map.set(s.id, s);
      }
    }
    return map;
  }, [skillsState]);

  // O catálogo oficial das 10 skills é SEMPRE a fonte primária de verdade dos cards
  const allSkills: SkillStatusInfo[] = React.useMemo(() => {
    return SKILLS_CATALOG.map(def => {
      const liveStatus = installedStatusMap.get(def.id);
      return {
        id: def.id,
        nome: def.nome,
        grupo: def.grupo,
        resumo: def.resumo,
        quando: def.quando,
        nota: def.nota,
        arquivosCount: def.arquivos.length,
        relativePath: `.agents/skills/${def.id}/`,
        installed: liveStatus ? Boolean(liveStatus.installed) : false,
        incomplete: liveStatus ? Boolean(liveStatus.incomplete) : false,
        missingFiles: liveStatus?.missingFiles,
        usar: def.usar
      };
    });
  }, [installedStatusMap]);

  // Total de skills instaladas
  const installedCount = React.useMemo(() => {
    if (typeof skillsState?.installedCount === "number") {
      return skillsState.installedCount;
    }
    return allSkills.filter(s => s.installed).length;
  }, [skillsState, allSkills]);

  const totalCount = SKILLS_CATALOG.length;

  // Categorias com contadores dinâmicos calculados a partir dos 10 itens do catálogo
  const categories = React.useMemo(() => {
    const aparenciaCount = allSkills.filter(s => s.grupo === "aparencia").length;
    const crescimentoCount = allSkills.filter(s => s.grupo === "crescimento").length;
    const tecnicoCount = allSkills.filter(s => s.grupo === "tecnico").length;

    return [
      { id: "todos", label: "Todos", count: allSkills.length },
      { id: "aparencia", label: "Aparência", count: aparenciaCount },
      { id: "crescimento", label: "Atrair e converter", count: crescimentoCount },
      { id: "tecnico", label: "Qualidade técnica", count: tecnicoCount }
    ];
  }, [allSkills]);

  // Filtragem estrita por categoria oficial
  const filteredSkills = React.useMemo(() => {
    if (selectedCategory === "todos") return allSkills;
    return allSkills.filter(s => s.grupo === selectedCategory);
  }, [allSkills, selectedCategory]);

  const handleInstallClick = async (skillId: string) => {
    if (actionBusySkillId) return;
    setActionBusySkillId(skillId);
    setErrorMessage(null);
    try {
      await onInstall(skillId);
    } catch (err: any) {
      setErrorMessage(err?.message || "Erro ao instalar a skill.");
    } finally {
      setActionBusySkillId(null);
    }
  };

  const handleRemoveClick = async (skillId: string) => {
    if (actionBusySkillId) return;
    setActionBusySkillId(skillId);
    setErrorMessage(null);
    try {
      await onRemove(skillId);
    } catch (err: any) {
      setErrorMessage(err?.message || "Erro ao remover a skill.");
    } finally {
      setActionBusySkillId(null);
    }
  };

  const handleRunClick = async (skillId: string) => {
    if (actionBusySkillId) return;
    setActionBusySkillId(skillId);
    setErrorMessage(null);
    try {
      await onRun(skillId);
    } catch (err: any) {
      setErrorMessage(err?.message || "Erro ao executar a skill.");
      setActionBusySkillId(null);
    }
  };

  return (
    <div className="skills-panel-container" id="conversation-panel-skills" role="tabpanel" aria-labelledby="conversation-tool-skills">
      {/* Cabeçalho do Painel */}
      <div className="skills-panel-header">
        <div className="skills-panel-title-group">
          <div className="skills-panel-icon-badge">
            <Sparkles size={20} />
          </div>
          <div className="skills-panel-title-text">
            <h2>Agent Skills</h2>
            <p>Playbooks de especialista no repositório</p>
            <span className="skills-panel-counter">
              {installedCount} de {totalCount} skills instaladas
            </span>
          </div>
        </div>
        <button
          type="button"
          className="skills-panel-close-btn"
          onClick={onClose}
          aria-label="Fechar painel de skills"
          title="Fechar painel de skills"
        >
          <X size={18} />
        </button>
      </div>

      {/* Mensagem de Erro Global se houver */}
      {errorMessage && (
        <div className="skills-panel-error-banner">
          <AlertTriangle size={15} />
          <span>{errorMessage}</span>
          <button type="button" onClick={() => setErrorMessage(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      {/* Barra de Filtros por Categoria */}
      <div className="skills-filter-bar">
        {categories.map(cat => (
          <button
            key={cat.id}
            type="button"
            className={`skills-filter-pill ${selectedCategory === cat.id ? "active" : ""}`}
            onClick={() => setSelectedCategory(cat.id)}
          >
            <span>{cat.label}</span>
            <span className="skills-filter-count">{cat.count}</span>
          </button>
        ))}
      </div>

      {/* Lista de Cards com Scroll Próprio */}
      <div className="skills-list-scroll">
        {isLoading && (
          <div className="skills-updating-pill">
            <Loader2 size={12} className="spin" />
            <span>Atualizando status das skills...</span>
          </div>
        )}

        {filteredSkills.map(skill => {
          const isBusy = actionBusySkillId === skill.id;

          return (
            <div
              key={skill.id}
              className={`skill-card ${skill.installed ? "installed" : ""}`}
            >
              {/* Cabeçalho do Card */}
              <div className="skill-card-head">
                <div className="skill-card-title-row">
                  <h3 className="skill-card-name">{skill.nome}</h3>
                  <span className={`skill-category-badge ${skill.grupo}`}>
                    {skill.grupo === "aparencia"
                      ? "Aparência"
                      : skill.grupo === "crescimento"
                      ? "Atrair e converter"
                      : "Qualidade técnica"}
                  </span>
                </div>
                <span
                  className={`skill-status-pill ${
                    skill.installed
                      ? "installed"
                      : skill.incomplete
                      ? "incomplete"
                      : "available"
                  }`}
                >
                  {skill.installed
                    ? "Instalada"
                    : skill.incomplete
                    ? "Incompleta"
                    : "Disponível"}
                </span>
              </div>

              {/* Descrição Resumida */}
              <p className="skill-card-desc">{skill.resumo}</p>

              {/* Metadados do Playbook */}
              <div className="skill-card-meta">
                <span>
                  Arquivos: {skill.arquivosCount} playbooks •{" "}
                  <code>{skill.relativePath}</code>
                </span>
              </div>

              {/* Linha de Ações */}
              <div className="skill-card-actions">
                {skill.installed ? (
                  <>
                    <button
                      type="button"
                      className="skill-btn-run"
                      onClick={() => void handleRunClick(skill.id)}
                      disabled={isBusy}
                      title="Executar no projeto com o agente de IA"
                    >
                      {isBusy ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <Sparkles size={13} />
                      )}
                      <span>Executar no projeto</span>
                    </button>

                    <button
                      type="button"
                      className="skill-btn-remove"
                      onClick={() => void handleRemoveClick(skill.id)}
                      disabled={isBusy || readOnly}
                      title="Remover skill do projeto"
                    >
                      {isBusy ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}
                      <span>Remover skill</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="skill-btn-install"
                    onClick={() => void handleInstallClick(skill.id)}
                    disabled={isBusy || readOnly || !projectPath}
                    title={
                      projectPath
                        ? "Instalar arquivos da skill no projeto atual"
                        : "Abra um projeto para instalar skills"
                    }
                  >
                    {isBusy ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    <span>+ Instalar no Projeto</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
