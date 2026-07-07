export class CartService {
  total(items) {
    return items.reduce((sum, item) => sum + item.price, 0);
  }

  explode() {
    return "real";
  }
}
