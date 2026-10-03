// World is in meters, laid out like a real court:
//   x: left/right from the center line (+ is right, seen from the near end)
//   z: depth from the near baseline (0) to the far baseline (COURT.length)
//   y: height above the ground

export const COURT = {
  length: 23.77,
  doublesWidth: 10.97,
  singlesWidth: 8.23,
  serviceFromNet: 6.4,
  netHeightCenter: 0.914,
  netHeightPost: 1.07,
  get netZ() {
    return this.length / 2;
  },
};
