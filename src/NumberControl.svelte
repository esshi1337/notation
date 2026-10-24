<script lang="ts">
  let { label, value = $bindable(), min, max, step = 1, precision = 0, defaultValue = min, unit = '', sliderStep = step, disabled = false }: {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    precision?: number;
    defaultValue?: number;
    unit?: string;
    sliderStep?: number;
    disabled?: boolean;
  } = $props();

  const instanceId = $props.id();
  const inputId = `${instanceId}-number`;
  let numericInput: HTMLInputElement;
  let progress = $derived(Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)));

  function normalize(candidate: number) {
    const bounded = Math.max(min, Math.min(max, candidate));
    const factor = 10 ** precision;
    return Math.round((bounded + Number.EPSILON) * factor) / factor;
  }
  function commit(candidate: number) {
    value = normalize(candidate);
  }
  function numeric(event: Event, finalize = false) {
    const field = event.currentTarget as HTMLInputElement;
    const raw = field.value.trim();
    const parsed = raw === '' ? Number.NaN : Number(raw);
    if (!finalize) {
      if (Number.isFinite(parsed) && parsed >= min && parsed <= max) commit(parsed);
      return;
    }
    const fallback = Number.isFinite(value) ? value : defaultValue;
    commit(Number.isFinite(parsed) ? parsed : fallback);
    field.value = String(value);
  }
  function stepBy(direction: number) {
    const current = Number.isFinite(value) ? value : defaultValue;
    commit(current + direction * step);
    if (numericInput) numericInput.value = String(value);
  }
</script>

<div class="settings-field settings-number-field">
  <label class="settings-field-label" for={inputId}>{label}{#if unit} <span class="settings-field-unit">({unit})</span>{/if}</label>
  <div class="number-control">
    <div class="number-stepper">
      <button type="button" aria-label={`Decrease ${label}`} disabled={disabled || value <= min} onclick={() => stepBy(-1)}><span aria-hidden="true">−</span></button>
      <input
        bind:this={numericInput}
        id={inputId}
        class="number-input"
        type="number"
        aria-label={label}
        {min}
        {max}
        {step}
        {value}
        {disabled}
        inputmode="decimal"
        oninput={(event) => numeric(event)}
        onchange={(event) => numeric(event, true)}
        onblur={(event) => numeric(event, true)}
      />
      <button type="button" aria-label={`Increase ${label}`} disabled={disabled || value >= max} onclick={() => stepBy(1)}><span aria-hidden="true">+</span></button>
    </div>
    <input
      class="number-range"
      type="range"
      aria-label={`${label} slider`}
      aria-valuetext={unit ? `${value} ${unit}` : String(value)}
      {min}
      {max}
      step={sliderStep}
      {value}
      {disabled}
      style={`--range-progress:${progress}%`}
      oninput={(event) => commit(Number(event.currentTarget.value))}
    />
  </div>
</div>
