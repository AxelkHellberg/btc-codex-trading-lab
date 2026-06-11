// ... rest of the code remains the same ...

// Update break-even stops
const breakEvenPrice = isLong
  ? roundToTickLong(entryPrice + (entryPrice - stopLoss), tickSize)
  : roundToTickShort(entryPrice - (entryPrice - stopLoss), tickSize);

// ... rest of the code remains the same ...

// Update trailing stops
const newStopLoss = isLong
  ? roundToTickLong(trailingStopPrice, tickSize)
  : roundToTickShort(trailingStopPrice, tickSize);