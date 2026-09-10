import React from "react";
import { resolveFileIconDef, resolveFolderIconDef } from "./iconResolver";

interface FileIconProps {
  fileName: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const FileIcon: React.FC<FileIconProps> = React.memo(
  ({ fileName, size = 14, className = "", style }) => {
    const def = resolveFileIconDef(fileName);
    const IconComp = def.icon;

    return (
      <IconComp
        size={size}
        className={`${def.className} ${className}`.trim()}
        style={{ color: def.color, ...style }}
      />
    );
  }
);

interface FolderIconProps {
  folderName: string;
  isOpen: boolean;
  size?: number;
  className?: string;
  isRoot?: boolean;
  style?: React.CSSProperties;
}

export const FolderIcon: React.FC<FolderIconProps> = React.memo(
  ({ folderName, isOpen, size = 14, className = "", isRoot = false, style }) => {
    const def = resolveFolderIconDef(folderName, isOpen, isRoot);
    const IconComp = def.icon;

    return (
      <IconComp
        size={size}
        className={`${def.className} ${className}`.trim()}
        style={{ color: def.color, ...style }}
      />
    );
  }
);
