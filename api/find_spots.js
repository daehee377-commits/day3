const { find_spots } = require("./tools");

module.exports = (req, res) => {
  const { area, indoor: raw } = req.query;
  const indoor = raw === "true" ? true : raw === "false" ? false : undefined;
  const result = find_spots({ area, indoor });
  res.status(result.error ? 400 : 200).json(result);
};
