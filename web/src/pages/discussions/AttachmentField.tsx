import { formatBytes } from '../../format';
import { IconClose, IconPaperclip } from '../../components/icons';

interface Props {
  onPick: (file: File | null) => void;
  disabled?: boolean;
  /** Nom accessible du champ ; il distingue les composeurs qui cohabitent (message, réponse). */
  label: string;
}

/**
 * Bouton « joindre un fichier » d'un composeur de message.
 *
 * C'est le champ lui-même qui porte le geste, habillé par le libellé qui l'entoure : un bouton
 * séparé qui déclencherait le champ ferait deux contrôles pour une seule action, tous deux annoncés
 * sous le même nom. Le champ reste donc dans l'arbre d'accessibilité — masqué à l'œil, pas au
 * clavier ni au lecteur d'écran — et sa valeur est remise à zéro après chaque choix, sinon
 * reprendre le même fichier après l'avoir retiré n'émettrait aucun `change`.
 */
export function AttachmentField({ onPick, disabled, label }: Props) {
  return (
    <label className="icon-btn attach-btn" title="Joindre un fichier">
      <IconPaperclip size={18} />
      <input
        type="file"
        className="visually-hidden"
        aria-label={label}
        disabled={disabled}
        onChange={(e) => {
          onPick(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
    </label>
  );
}

/** Fichier retenu, affiché au-dessus de la barre d'envoi tant qu'il n'est pas parti. */
export function AttachmentDraft({ file, onClear }: { file: File; onClear: () => void }) {
  return (
    <p className="attachment-draft">
      <IconPaperclip size={14} />
      <span className="attachment-name">{file.name}</span>
      <span className="muted">{formatBytes(file.size)}</span>
      <button
        type="button"
        className="icon-btn"
        onClick={onClear}
        title="Retirer le fichier"
        aria-label="Retirer le fichier"
      >
        <IconClose size={14} />
      </button>
    </p>
  );
}
