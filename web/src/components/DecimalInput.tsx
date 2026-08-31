import type { InputHTMLAttributes } from 'react';
import { isDecimalDraft } from '../decimal';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'inputMode' | 'value' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
};

/**
 * Champ d'un nombre à décimales : « 1,3 » comme « 1.3 ».
 *
 * Champ texte à clavier numérique plutôt que `type="number"`, que les claviers
 * mobiles français font échouer sur la virgule. La frappe est filtrée pour qu'il
 * n'y entre que des chiffres et un seul séparateur ; la valeur se lit avec
 * `parseDecimal`.
 */
export function DecimalInput({ value, onValueChange, ...rest }: Props) {
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={value}
      onChange={(e) => {
        if (isDecimalDraft(e.target.value)) onValueChange(e.target.value);
      }}
    />
  );
}
