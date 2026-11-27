const segmentsOf = (path: string): string[] => path.split('/').filter((s) => s !== '');

const suffix = (segments: readonly string[], length: number): string => segments.slice(-length).join('/');

/** Labels `paths` by their shortest trailing path that no other path of the list shares. */
export const uniqueLabels = (paths: readonly string[]): string[] => {
  const all = paths.map(segmentsOf);
  return all.map((segments, i) => {
    for (let length = 1; length < segments.length; length++) {
      const label = suffix(segments, length);
      if (all.every((other, j) => j === i || suffix(other, length) !== label)) return label;
    }
    return segments.join('/');
  });
};
