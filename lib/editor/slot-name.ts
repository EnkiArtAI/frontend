/**
 * On a phone the sheet is the editor, and it has no field to name a variable.
 * A slot written there stayed unnamed: the save found no variable for it and
 * refused the prompt, and the value typed in the sheet never reached the
 * image. An unnamed slot is therefore named by its own text ("[cat]" is the
 * variable "cat"), which is the token already standing in the prompt.
 *
 * On a desktop the artist names variables in the editor and nothing changes.
 */
export function nameSlotByItsText<V extends { name: string; fullToken: string }>(variable: V, sheetIsEditor: boolean): V {
  return sheetIsEditor && !variable.name.trim() ? { ...variable, name: variable.fullToken.slice(1, -1) } : variable;
}
