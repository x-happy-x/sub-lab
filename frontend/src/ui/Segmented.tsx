import { Tooltip } from "./Tooltip";

export type SegmentedOption<T extends string = string> = {
  value: T;
  label: string;
  tip?: string;
};

type Props<T extends string = string> = {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  ariaLabel?: string;
};

/** Сегментированный переключатель: один выбранный вариант из нескольких. */
export function Segmented<T extends string = string>({ options, value, onChange, className = "", ariaLabel }: Props<T>) {
  return (
    <div className={`segmented ${className}`.trim()} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const button = (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={`segmented-item ${option.value === value ? "active" : ""}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
        return option.tip ? <Tooltip key={option.value} content={option.tip}>{button}</Tooltip> : button;
      })}
    </div>
  );
}
