export const menuIconPaths = {
  throw:
    'M21 12 A9 9 0 1 1 3 12 A9 9 0 1 1 21 12 M7 4 Q14 12 7 20 M17 4 Q10 12 17 20',
  catch:
    'M8 13 V5 Q8 3 10 3 Q12 3 12 5 V11 M12 5 V3 Q12 1 14 1 Q16 1 16 3 V11 M16 5 Q16 3 18 3 Q20 3 20 5 V13 M20 9 Q20 7 22 7 V16 Q22 22 16 22 H12 Q10 22 8 20 L3 14 Q2 12 4 11 Q5 11 8 15 Z',
  interference: 'M12 3 L22 21 H2 Z M12 9 V14 M12 17 V18'
} as const
export type MenuIconKind = keyof typeof menuIconPaths
