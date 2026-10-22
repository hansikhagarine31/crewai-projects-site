import './Legend.css';

// Labels as in design/reference.html.
const ITEMS = [
  { variant: 'input', text: 'Input / start' },
  { variant: 'step', text: 'Step or agent' },
  { variant: 'crew', text: 'Crew inside a Flow' },
  { variant: 'router', text: 'Router' },
  { variant: 'dashed', text: 'Tool or human step' },
  { variant: 'output', text: 'Output' },
];

export default function Legend() {
  return (
    <ul className="legend" aria-label="Legend">
      {ITEMS.map((item) => (
        <li key={item.variant}>
          <i className={`legend__swatch legend__swatch--${item.variant}`} aria-hidden="true" />
          {item.text}
        </li>
      ))}
    </ul>
  );
}
