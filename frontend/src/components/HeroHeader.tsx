type Props = {
  logoSrc: string;
  subtitle: string;
};

export function HeroHeader({ logoSrc, subtitle }: Props) {
  return (
    <header className="hero">
      <div className="hero-brand">
        <img className="hero-logo" src={logoSrc} alt="SubLab icon" />
        <div className="hero-copy">
          <h1 className="hero-title-pixel">SubLab</h1>
          <p className="hero-sub-title">{subtitle}</p>
        </div>
      </div>
    </header>
  );
}
