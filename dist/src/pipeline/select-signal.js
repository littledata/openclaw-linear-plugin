/**
 * select-signal.ts — builders for Linear "select" agent signals.
 *
 * A `select` signal turns an elicitation into a clickable option list in the
 * Linear UI. The chosen option's `value` comes back as a normal `prompt`
 * activity, so it flows through the same reply handlers a typed answer does —
 * which is why each builder's `value` is chosen to round-trip cleanly through
 * the existing reply parser.
 *
 * See https://linear.app/developers/agent-signals
 */
/** The catch-all "work on every candidate" option. Value matches parseRepoSelection's `all` keyword. */
const ALL_OPTION = { label: "All of them", value: "all" };
/**
 * Build select options for a repo-selection elicitation: one per candidate
 * (label === value === repo name) plus an "all" option when there's a choice.
 * @param candidates - repo names in the order they're presented to the user
 * @param recommended - candidate names whose labels should be marked recommended
 * @returns a select signal, or undefined when there are no candidates
 */
export function repoSelectSignal(candidates, recommended = []) {
    const recommendedSet = new Set(recommended);
    const options = candidates.map((c) => ({
        label: recommendedSet.has(c) ? `${c} (recommended)` : c,
        value: c,
    }));
    if (!options.length)
        return undefined;
    if (candidates.length > 1)
        options.push(ALL_OPTION);
    return { signal: "select", signalMetadata: { options } };
}
/**
 * Build a select signal from a grill question's discrete answer choices.
 * @param values - the allowed answer strings (blank entries are dropped)
 * @returns a select signal, or undefined when there are no usable choices
 */
export function optionsSignal(values) {
    const options = values
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => ({ label: v, value: v }));
    return options.length ? { signal: "select", signalMetadata: { options } } : undefined;
}
