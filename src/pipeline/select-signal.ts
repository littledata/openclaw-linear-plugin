/**
 * select-signal.ts — builders for Linear "select" agent signals.
 *
 * A `select` signal turns an elicitation into a clickable option list in the
 * Linear UI. The chosen option's `value` comes back as a normal `prompt`
 * activity, so it flows through the same reply handlers a typed answer does —
 * which is why each builder's `value` is chosen to round-trip cleanly through
 * the existing parsers (parseRepoSelection / parseResumeDecision).
 *
 * See https://linear.app/developers/agent-signals
 */

export interface SelectOption {
  label?: string;
  value: string;
}

export interface SelectSignal {
  signal: "select";
  signalMetadata: { options: SelectOption[] };
}

/** The catch-all "work on every candidate" option. Value matches parseRepoSelection's `all` keyword. */
const ALL_OPTION: SelectOption = { label: "All of them", value: "all" };

/**
 * Build select options for a repo-selection elicitation: one per candidate
 * (label === value === repo name) plus an "all" option when there's a choice.
 * @param candidates - repo names in the order they're presented to the user
 * @returns a select signal, or undefined when there are no candidates
 */
export function repoSelectSignal(candidates: string[]): SelectSignal | undefined {
  const options: SelectOption[] = candidates.map((c) => ({ label: c, value: c }));
  if (!options.length) return undefined;
  if (candidates.length > 1) options.push(ALL_OPTION);
  return { signal: "select", signalMetadata: { options } };
}

/** Options for the resume-or-fresh gate. Values match parseResumeDecision. */
export const RESUME_SELECT: SelectSignal = {
  signal: "select",
  signalMetadata: {
    options: [
      { label: "Resume — continue prior work", value: "resume" },
      { label: "Start fresh — re-plan from scratch", value: "fresh" },
    ],
  },
};

/**
 * Build a select signal from a grill question's discrete answer choices.
 * @param values - the allowed answer strings (blank entries are dropped)
 * @returns a select signal, or undefined when there are no usable choices
 */
export function optionsSignal(values: string[]): SelectSignal | undefined {
  const options = values
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v): SelectOption => ({ label: v, value: v }));
  return options.length ? { signal: "select", signalMetadata: { options } } : undefined;
}
