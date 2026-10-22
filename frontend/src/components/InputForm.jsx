import { useId, useRef, useState } from 'react';
import {
  formatBytes,
  initialValues,
  MAX_UPLOAD_BYTES,
  validateForm,
} from '../lib/validateInputs.js';
import { samples, sampleValues } from '../data/samples.js';
import './InputForm.css';

const hintFor = (field) => {
  switch (field.type) {
    case 'text': {
      if (field.minLength && field.maxLength) return `Between ${field.minLength} and ${field.maxLength} characters.`;
      return field.maxLength ? `Up to ${field.maxLength} characters.` : null;
    }
    case 'url':
      return 'A web address that begins with https://.';
    case 'urls':
      return `Between ${field.minItems ?? 1} and ${field.maxItems ?? 3} web addresses, each beginning with https://.`;
    case 'file': {
      const size = `${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`;
      const count = field.maxFiles > 1 ? `Up to ${field.maxFiles} files` : 'One file';
      return `${count}. Accepted types: ${field.extensions.join(', ')}. Maximum size: ${size} per file.`;
    }
    default:
      return null;
  }
};

function FieldShell({ field, id, error, hint, children, legend }) {
  const Wrapper = legend ? 'fieldset' : 'div';
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <Wrapper className="field">
      {legend ? (
        <legend className="field__label">
          {field.label}
          <span className="field__meta">{field.required ? ' (required)' : ' (optional)'}</span>
        </legend>
      ) : (
        <label className="field__label" htmlFor={id}>
          {field.label}
          <span className="field__meta">{field.required ? ' (required)' : ' (optional)'}</span>
        </label>
      )}
      {children(describedBy)}
      {hint && (
        <p id={`${id}-hint`} className="field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field__error">
          {error}
        </p>
      )}
    </Wrapper>
  );
}

function FileField({ field, id, value, onChange, invalid, describedBy }) {
  const input = useRef(null);
  const add = (event) => {
    const chosen = Array.from(event.target.files ?? []);
    onChange(field.maxFiles > 1 ? [...value, ...chosen] : chosen);
    event.target.value = ''; // allow choosing the same file again after removing it
  };

  return (
    <>
      <div className="file">
        <input
          ref={input}
          id={id}
          className="file__input"
          type="file"
          accept={field.extensions.join(',')}
          multiple={field.maxFiles > 1}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={add}
        />
        <label htmlFor={id} className="button button--quiet file__button">
          {field.maxFiles > 1 ? 'Choose files' : 'Choose a file'}
        </label>
      </div>
      {value.length > 0 && (
        <ul className="file__list" aria-label={`Selected files for ${field.label}`}>
          {value.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <span>
                {file.name} <span className="field__meta">({formatBytes(file.size)})</span>
              </span>
              <button type="button" className="link-button" onClick={() => onChange(value.filter((_, i) => i !== index))}>
                Remove <span className="visually-hidden">{file.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function UrlListField({ field, id, value, onChange, invalid, describedBy }) {
  const max = field.maxItems ?? 3;
  const update = (index, text) => onChange(value.map((item, i) => (i === index ? text : item)));
  return (
    <>
      <ul className="urls">
        {value.map((item, index) => (
          <li key={index}>
            <input
              id={index === 0 ? id : `${id}-${index}`}
              className="input"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck="false"
              placeholder="https://example.com"
              aria-label={`${field.label}, address ${index + 1}`}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              value={item}
              onChange={(event) => update(index, event.target.value)}
            />
            {value.length > 1 && (
              <button type="button" className="link-button" onClick={() => onChange(value.filter((_, i) => i !== index))}>
                Remove <span className="visually-hidden">address {index + 1}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {value.length < max && (
        <button type="button" className="link-button" onClick={() => onChange([...value, ''])}>
          Add another address
        </button>
      )}
    </>
  );
}

/**
 * Renders a project's inputs and validates them before anything is sent.
 *
 * @param {{
 *   project: import('../data/projects.js').Project,
 *   active?: boolean,            Disables the Run button while a run is in progress.
 *   unavailableReason?: string,  When set, the form cannot be submitted and this is explained.
 *   onSubmit: (values: Record<string, unknown>) => void,
 * }} props
 */
export default function InputForm({ project, active = false, unavailableReason, onSubmit }) {
  const prefix = useId();
  const form = useRef(null);
  const [values, setValues] = useState(() => initialValues(project));
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [filled, setFilled] = useState(false);

  const { errors, form: formError } = validateForm(project, values);
  const visible = (key) => (submitted || touched[key] ? errors[key] : undefined);
  const set = (key, value) => setValues((current) => ({ ...current, [key]: value }));
  const touch = (key) => setTouched((current) => ({ ...current, [key]: true }));

  function fillSample() {
    setValues(sampleValues(project, initialValues(project)));
    setTouched({});
    setSubmitted(false);
    setFilled(true);
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (active || unavailableReason) return;
    setSubmitted(true);
    const result = validateForm(project, values);
    if (!result.valid) {
      const firstKey = project.inputs.find((field) => result.errors[field.key])?.key;
      const target = firstKey ? form.current.querySelector(`[data-field="${firstKey}"] :is(input, textarea, select)`) : null;
      (target ?? form.current.querySelector('.form__error'))?.focus();
      return;
    }
    onSubmit(values);
  }

  return (
    <form ref={form} className="form" onSubmit={handleSubmit} noValidate aria-label={`${project.title}: inputs`}>
      {submitted && formError && (
        <p className="form__error" role="alert" tabIndex={-1}>
          {formError}
        </p>
      )}

      {project.inputs.map((field) => {
        const id = `${prefix}-${field.key}`;
        const error = visible(field.key);
        const hint = [hintFor(field), field.hint].filter(Boolean).join(' ') || null;
        const invalid = error ? true : undefined;

        let control;
        if (field.type === 'file') {
          control = (describedBy) => (
            <FileField field={field} id={id} value={values[field.key]} onChange={(v) => { set(field.key, v); touch(field.key); }} invalid={invalid} describedBy={describedBy} />
          );
        } else if (field.type === 'urls') {
          control = (describedBy) => (
            <UrlListField field={field} id={id} value={values[field.key]} onChange={(v) => { set(field.key, v); touch(field.key); }} invalid={invalid} describedBy={describedBy} />
          );
        } else if (field.type === 'select') {
          control = (describedBy) => (
            <select
              id={id}
              className="input"
              value={values[field.key]}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onChange={(event) => set(field.key, event.target.value)}
              onBlur={() => touch(field.key)}
            >
              <option value="">Select an option</option>
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          );
        } else if (field.type === 'text' && field.multiline) {
          control = (describedBy) => (
            <textarea
              id={id}
              className="input input--area"
              rows={6}
              value={values[field.key]}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onChange={(event) => set(field.key, event.target.value)}
              onBlur={() => touch(field.key)}
            />
          );
        } else {
          control = (describedBy) => (
            <input
              id={id}
              className="input"
              type={field.type === 'url' ? 'url' : 'text'}
              inputMode={field.type === 'url' ? 'url' : undefined}
              autoComplete="off"
              spellCheck={field.type === 'url' ? 'false' : undefined}
              placeholder={field.type === 'url' ? 'https://example.com' : undefined}
              value={values[field.key]}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onChange={(event) => set(field.key, event.target.value)}
              onBlur={() => touch(field.key)}
            />
          );
        }

        return (
          <div key={field.key} data-field={field.key}>
            <FieldShell field={field} id={id} error={error} hint={hint} legend={field.type === 'urls'}>
              {control}
            </FieldShell>
          </div>
        );
      })}

      {unavailableReason && <p className="form__unavailable">{unavailableReason}</p>}

      <div className="form__actions">
        <button type="submit" className="button" disabled={active || Boolean(unavailableReason)} aria-busy={active || undefined}>
          Run
        </button>
        {samples[project.id] && (
          <button type="button" className="button button--quiet" disabled={active} onClick={fillSample}>
            Sample input
          </button>
        )}
        {active && <span className="form__busy">A run is in progress.</span>}
      </div>
      <div className="visually-hidden" role="status">
        {filled ? 'The form has been filled with a sample input. You may change it before running.' : ''}
      </div>
    </form>
  );
}
